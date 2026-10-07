//! Discovery (Epic 11.1).
//!
//! A `DiscoveryCard` is a public, non-delegated account the room owner publishes
//! on purpose, holding only the fields they chose to show. It is never derived
//! from room or loan state. Lenders who want in add themselves to the room's
//! ER-only `JoinQueue`, which only the room owner can read.

use crate::constants::{CARD_SEED, JOIN_QUEUE_SEED, ROOM_STATE_SEED};
use crate::error::PrivateLoanError;
use crate::room::{load, RoomAnchor, RoomState, Sponsor};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::structs::{Member, AUTHORITY_FLAG, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG};
use ephemeral_rollups_sdk::anchor::{MagicProgram, PermissionProgram};
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;

pub const MAX_JOIN_REQUESTS: usize = 16;

/// Which card fields the publisher chose to show.
pub const SHOW_AMOUNT: u8 = 1 << 0;
pub const SHOW_RATE: u8 = 1 << 1;
pub const SHOW_DURATION: u8 = 1 << 2;
pub const SHOW_COLLATERAL: u8 = 1 << 3;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct CardArgs {
    pub show: u8,
    pub amount_min: u64,
    pub amount_max: u64,
    pub max_interest_bps: u16,
    pub duration_seconds: i64,
    /// Human-readable collateral note, e.g. "wSOL at up to 60% LTV".
    pub collateral_note: [u8; 48],
}

#[account]
#[derive(InitSpace)]
pub struct DiscoveryCard {
    pub card_id: [u8; 32],
    pub room: Pubkey,
    pub publisher: Pubkey,
    pub fields: CardArgs,
    pub active: bool,
    pub bump: u8,
}

/// Fields the publisher did not choose are stored as zero, not hidden copies.
fn redact(a: &CardArgs) -> CardArgs {
    CardArgs {
        show: a.show,
        amount_min: if a.show & SHOW_AMOUNT != 0 { a.amount_min } else { 0 },
        amount_max: if a.show & SHOW_AMOUNT != 0 { a.amount_max } else { 0 },
        max_interest_bps: if a.show & SHOW_RATE != 0 { a.max_interest_bps } else { 0 },
        duration_seconds: if a.show & SHOW_DURATION != 0 { a.duration_seconds } else { 0 },
        collateral_note: if a.show & SHOW_COLLATERAL != 0 { a.collateral_note } else { [0; 48] },
    }
}

pub fn publish_card(ctx: Context<PublishCard>, card_id: [u8; 32], fields: CardArgs) -> Result<()> {
    // The anchor is delegated on Solana but keeps its data: discriminator, room id, creator.
    let room = ctx.accounts.room.to_account_info();
    let data = room.try_borrow_data()?;
    require!(data.len() >= 72 && data[..8] == *RoomAnchor::DISCRIMINATOR, PrivateLoanError::InvalidRecord);
    let creator = Pubkey::new_from_array(data[40..72].try_into().unwrap());
    require_keys_eq!(creator, ctx.accounts.publisher.key(), PrivateLoanError::NotRoomOwner);
    drop(data);
    let card = &mut ctx.accounts.card;
    card.card_id = card_id;
    card.room = ctx.accounts.room.key();
    card.publisher = ctx.accounts.publisher.key();
    card.fields = redact(&fields);
    card.active = true;
    card.bump = ctx.bumps.card;
    Ok(())
}

/// Closing returns the rent; the card disappears from discovery.
pub fn retract_card(_ctx: Context<RetractCard>) -> Result<()> {
    Ok(())
}

pub fn open_join_queue(ctx: Context<OpenJoinQueue>) -> Result<()> {
    let a = &ctx.accounts;
    let state: RoomState = load(&a.room_state.to_account_info())?;
    require_keys_eq!(state.owner, a.owner.key(), PrivateLoanError::NotRoomOwner);
    require!(a.queue.data_is_empty(), PrivateLoanError::RoomAlreadyInitialized);
    let anchor_key = a.anchor.key();
    let bump = [ctx.bumps.queue];
    Sponsor { anchor: &a.anchor, vault: &a.vault, magic_program: &a.magic_program, permission_program: &a.permission_program }
        .create_private_record(
            &a.queue.to_account_info(),
            &a.queue_permission.to_account_info(),
            &[JOIN_QUEUE_SEED, anchor_key.as_ref(), &bump],
            (4 + MAX_JOIN_REQUESTS * 40) as u32,
            vec![Member { flags: AUTHORITY_FLAG | TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG, pubkey: a.owner.key() }],
        )
}

/// Anyone may ask to join; only the owner can read the queue. Asking twice is a no-op.
pub fn request_join(ctx: Context<RequestJoin>) -> Result<()> {
    let info = ctx.accounts.queue.to_account_info();
    require_keys_eq!(*info.owner, crate::ID, PrivateLoanError::InvalidRecord);
    let who = ctx.accounts.requester.key();
    let mut data = info.try_borrow_mut_data()?;
    let count = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
    for i in 0..count.min(MAX_JOIN_REQUESTS) {
        if data[4 + i * 40..4 + i * 40 + 32] == who.to_bytes() {
            return Ok(());
        }
    }
    let slot = count % MAX_JOIN_REQUESTS;
    let o = 4 + slot * 40;
    data[o..o + 32].copy_from_slice(who.as_ref());
    data[o + 32..o + 40].copy_from_slice(&Clock::get()?.unix_timestamp.to_le_bytes());
    data[0..4].copy_from_slice(&((count + 1) as u32).to_le_bytes());
    Ok(())
}

#[derive(Accounts)]
#[instruction(card_id: [u8; 32])]
pub struct PublishCard<'info> {
    #[account(mut)]
    pub publisher: Signer<'info>,
    /// The room anchor on Solana. Delegated, so read through its stored creator only.
    /// CHECK: Owned by the delegation program while delegated; creator checked in the handler.
    pub room: UncheckedAccount<'info>,
    #[account(init, payer = publisher, space = 8 + DiscoveryCard::INIT_SPACE, seeds = [CARD_SEED, card_id.as_ref()], bump)]
    pub card: Account<'info, DiscoveryCard>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RetractCard<'info> {
    #[account(mut)]
    pub publisher: Signer<'info>,
    #[account(mut, has_one = publisher @ PrivateLoanError::NotRoomOwner, close = publisher)]
    pub card: Account<'info, DiscoveryCard>,
}

#[derive(Accounts)]
pub struct OpenJoinQueue<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub anchor: Account<'info, RoomAnchor>,
    /// CHECK: ER-only `RoomState`; owner checked in the handler.
    #[account(seeds = [ROOM_STATE_SEED, anchor.key().as_ref()], bump)]
    pub room_state: UncheckedAccount<'info>,
    /// CHECK: ER-only `JoinQueue`, created here.
    #[account(mut, seeds = [JOIN_QUEUE_SEED, anchor.key().as_ref()], bump)]
    pub queue: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `queue`.
    #[account(mut)]
    pub queue_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[derive(Accounts)]
pub struct RequestJoin<'info> {
    pub requester: Signer<'info>,
    pub anchor: Account<'info, RoomAnchor>,
    /// CHECK: ER-only `JoinQueue`, written in place.
    #[account(mut, seeds = [JOIN_QUEUE_SEED, anchor.key().as_ref()], bump)]
    pub queue: UncheckedAccount<'info>,
}
