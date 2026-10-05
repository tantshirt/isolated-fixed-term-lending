//! Private rooms (Epic 9.2).
//!
//! `RoomAnchor` is the only delegated account. It holds the opaque room id, the
//! creator (already public as the signer of `open_room`), and lamports that pay
//! rent for the room's ER-only records. Membership, messages, and sessions live
//! in ER-only records that never reach Solana (gates 8.3 and 8.7), each with an
//! ephemeral permission listing only active members.

use crate::constants::{ROOM_SEED, ROOM_STATE_SEED, ROOM_THREAD_SEED, SESSION_SEED, TEE_VALIDATOR};
use crate::error::PrivateLoanError;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use ephemeral_rollups_sdk::access_control::instructions::{
    CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, Member, AUTHORITY_FLAG, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::anchor::{delegate, MagicProgram, PermissionProgram};
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;

pub const MAX_MEMBERS: usize = 8;
pub const MAX_MESSAGES: usize = 16;
pub const MAX_BODY: usize = 140;
/// Lamports moved into the anchor so it can sponsor the room's ER-only records.
pub const SPONSOR_LAMPORTS: u64 = 20_000_000;
/// Longest session a wallet may authorise.
pub const MAX_SESSION_SECONDS: i64 = 86_400;

pub const ROLE_BORROWER: u8 = 1;
pub const ROLE_LENDER: u8 = 2;
pub const ROLE_VIEWER: u8 = 3;

/// Session scope bits. Financial actions have no bit: they always need the wallet.
pub const SCOPE_POST_MESSAGE: u32 = 1 << 0;
pub const SCOPE_EDIT_DRAFT: u32 = 1 << 1;
pub const SCOPE_REVISE_PROPOSAL: u32 = 1 << 2;
pub const SCOPE_APPROVED_AI_REQUEST: u32 = 1 << 3;
pub const SCOPE_ALL_NONFINANCIAL: u32 =
    SCOPE_POST_MESSAGE | SCOPE_EDIT_DRAFT | SCOPE_REVISE_PROPOSAL | SCOPE_APPROVED_AI_REQUEST;

#[account]
#[derive(InitSpace)]
pub struct RoomAnchor {
    pub room_id: [u8; 32],
    pub creator: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct MemberSlot {
    pub pubkey: Pubkey,
    pub role: u8,
    pub active: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RoomState {
    pub version: u8,
    pub owner: Pubkey,
    pub revision: u64,
    pub members: [MemberSlot; MAX_MEMBERS],
}

impl RoomState {
    pub const LEN: usize = 1 + 32 + 8 + MAX_MEMBERS * 34;

    pub fn active(&self, who: &Pubkey) -> bool {
        self.members.iter().any(|m| m.active && m.pubkey == *who)
    }

    fn permission_members(&self) -> Vec<Member> {
        let seen = TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG;
        self.members
            .iter()
            .filter(|m| m.active)
            .map(|m| Member {
                flags: if m.pubkey == self.owner { AUTHORITY_FLAG | seen } else { seen },
                pubkey: m.pubkey,
            })
            .collect()
    }
}

/// Thread layout, written in place: `count: u32`, then `MAX_MESSAGES` slots of
/// `author (32) | ts i64 (8) | len u16 (2) | body (MAX_BODY)`. A freshly created
/// ER-only record is zeroed, which is a valid empty thread. The thread is never
/// deserialized whole: at 2.9 KB it would overflow the 4 KB SBF stack frame.
pub struct RoomThread;

impl RoomThread {
    pub const SLOT: usize = 32 + 8 + 2 + MAX_BODY;
    pub const LEN: usize = 4 + MAX_MESSAGES * Self::SLOT;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SessionScope {
    pub anchor: Pubkey,
    pub authority: Pubkey,
    pub session_key: Pubkey,
    pub expires_at: i64,
    pub scope: u32,
    pub revoked: bool,
}

impl SessionScope {
    pub const LEN: usize = 32 * 3 + 8 + 4 + 1;
}

fn load<T: AnchorDeserialize>(info: &AccountInfo) -> Result<T> {
    require_keys_eq!(*info.owner, crate::ID, PrivateLoanError::InvalidRecord);
    let data = info.try_borrow_data()?;
    T::deserialize(&mut &data[..]).map_err(|_| error!(PrivateLoanError::InvalidRecord))
}

fn store<T: AnchorSerialize>(info: &AccountInfo, value: &T) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    value
        .serialize(&mut &mut data[..])
        .map_err(|_| error!(PrivateLoanError::InvalidRecord))
}

struct Sponsor<'a, 'info> {
    anchor: &'a Account<'info, RoomAnchor>,
    vault: &'a UncheckedAccount<'info>,
    magic_program: &'a Program<'info, MagicProgram>,
    permission_program: &'a Program<'info, PermissionProgram>,
}

impl<'a, 'info> Sponsor<'a, 'info> {
    fn seeds(&self) -> [&[u8]; 3] {
        [ROOM_SEED, &self.anchor.room_id, core::slice::from_ref(&self.anchor.bump)]
    }

    /// Creates an ER-only record and its private permission in one step.
    fn create_private_record(
        &self,
        record: &AccountInfo<'info>,
        permission: &AccountInfo<'info>,
        record_seeds: &[&[u8]],
        len: u32,
        members: Vec<Member>,
    ) -> Result<()> {
        let anchor_info = self.anchor.to_account_info();
        let vault_info = self.vault.to_account_info();
        let anchor_seeds = self.seeds();
        EphemeralAccount::new(&anchor_info, record, &vault_info)
            .with_signer_seeds(&[&anchor_seeds, record_seeds])
            .create(len)?;
        CreateEphemeralPermissionCpi {
            permissioned_account: record.clone(),
            permission: permission.clone(),
            payer: anchor_info,
            vault: vault_info,
            magic_program: self.magic_program.to_account_info(),
            permission_program: self.permission_program.to_account_info(),
            args: EphemeralMembersArgs { is_private: true, members },
        }
        .invoke_signed(&[&anchor_seeds, record_seeds])?;
        Ok(())
    }

    fn set_members(
        &self,
        record: &AccountInfo<'info>,
        permission: &AccountInfo<'info>,
        record_seeds: &[&[u8]],
        members: Vec<Member>,
    ) -> Result<()> {
        let anchor_seeds = self.seeds();
        UpdateEphemeralPermissionCpi {
            permissioned_account: record.clone(),
            permission: permission.clone(),
            payer: self.anchor.to_account_info(),
            authority: record.clone(),
            vault: self.vault.to_account_info(),
            magic_program: self.magic_program.to_account_info(),
            permission_program: self.permission_program.to_account_info(),
            authority_is_signer: false,
            args: EphemeralMembersArgs { is_private: true, members },
        }
        .invoke_signed(&[&anchor_seeds, record_seeds])?;
        Ok(())
    }
}

// ---------------------------------------------------------------- base layer

pub fn open_room(ctx: Context<OpenRoom>, room_id: [u8; 32]) -> Result<()> {
    let anchor = &mut ctx.accounts.anchor;
    anchor.room_id = room_id;
    anchor.creator = ctx.accounts.creator.key();
    anchor.bump = ctx.bumps.anchor;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.anchor.to_account_info(),
            },
        ),
        SPONSOR_LAMPORTS,
    )
}

/// Sent in the same transaction as `open_room`.
pub fn delegate_room(ctx: Context<DelegateRoom>, room_id: [u8; 32]) -> Result<()> {
    ctx.accounts.delegate_anchor(
        &ctx.accounts.creator,
        &[ROOM_SEED, &room_id],
        DelegateConfig { validator: Some(TEE_VALIDATOR), ..Default::default() },
    )?;
    Ok(())
}

// ------------------------------------------------------------- ephemeral rollup

pub fn init_room(ctx: Context<InitRoom>) -> Result<()> {
    let a = &ctx.accounts;
    require_keys_eq!(a.anchor.creator, a.owner.key(), PrivateLoanError::NotRoomOwner);
    require!(a.state.data_is_empty(), PrivateLoanError::RoomAlreadyInitialized);

    let anchor_key = a.anchor.key();
    let mut members = [MemberSlot::default(); MAX_MEMBERS];
    members[0] = MemberSlot { pubkey: a.owner.key(), role: ROLE_VIEWER, active: true };
    let state = RoomState { version: 1, owner: a.owner.key(), revision: 0, members };

    let sponsor = Sponsor {
        anchor: &a.anchor,
        vault: &a.vault,
        magic_program: &a.magic_program,
        permission_program: &a.permission_program,
    };
    let state_bump = [ctx.bumps.state];
    let thread_bump = [ctx.bumps.thread];
    sponsor.create_private_record(
        &a.state.to_account_info(),
        &a.state_permission.to_account_info(),
        &[ROOM_STATE_SEED, anchor_key.as_ref(), &state_bump],
        RoomState::LEN as u32,
        state.permission_members(),
    )?;
    sponsor.create_private_record(
        &a.thread.to_account_info(),
        &a.thread_permission.to_account_info(),
        &[ROOM_THREAD_SEED, anchor_key.as_ref(), &thread_bump],
        RoomThread::LEN as u32,
        state.permission_members(),
    )?;
    store(&a.state.to_account_info(), &state)
}

fn update_members(ctx: &Context<ManageMembers>, state: &RoomState) -> Result<()> {
    let a = &ctx.accounts;
    let anchor_key = a.anchor.key();
    let sponsor = Sponsor {
        anchor: &a.anchor,
        vault: &a.vault,
        magic_program: &a.magic_program,
        permission_program: &a.permission_program,
    };
    let state_bump = [ctx.bumps.state];
    let thread_bump = [ctx.bumps.thread];
    sponsor.set_members(
        &a.state.to_account_info(),
        &a.state_permission.to_account_info(),
        &[ROOM_STATE_SEED, anchor_key.as_ref(), &state_bump],
        state.permission_members(),
    )?;
    sponsor.set_members(
        &a.thread.to_account_info(),
        &a.thread_permission.to_account_info(),
        &[ROOM_THREAD_SEED, anchor_key.as_ref(), &thread_bump],
        state.permission_members(),
    )?;
    store(&a.state.to_account_info(), state)
}

pub fn invite_member(ctx: Context<ManageMembers>, member: Pubkey, role: u8) -> Result<()> {
    require!(matches!(role, ROLE_BORROWER | ROLE_LENDER | ROLE_VIEWER), PrivateLoanError::InvalidRole);
    let mut state: RoomState = load(&ctx.accounts.state.to_account_info())?;
    require_keys_eq!(state.owner, ctx.accounts.owner.key(), PrivateLoanError::NotRoomOwner);
    require!(!state.active(&member), PrivateLoanError::AlreadyMember);
    let slot = state
        .members
        .iter_mut()
        .find(|m| !m.active)
        .ok_or(error!(PrivateLoanError::RoomFull))?;
    *slot = MemberSlot { pubkey: member, role, active: true };
    state.revision = state.revision.saturating_add(1);
    update_members(&ctx, &state)
}

pub fn revoke_member(ctx: Context<ManageMembers>, member: Pubkey) -> Result<()> {
    let mut state: RoomState = load(&ctx.accounts.state.to_account_info())?;
    require_keys_eq!(state.owner, ctx.accounts.owner.key(), PrivateLoanError::NotRoomOwner);
    require_keys_neq!(member, state.owner, PrivateLoanError::CannotRevokeOwner);
    let slot = state
        .members
        .iter_mut()
        .find(|m| m.active && m.pubkey == member)
        .ok_or(error!(PrivateLoanError::NotMember))?;
    slot.active = false;
    state.revision = state.revision.saturating_add(1);
    update_members(&ctx, &state)
}

pub fn create_session(ctx: Context<CreateSession>, session_key: Pubkey, expires_at: i64, scope: u32) -> Result<()> {
    let a = &ctx.accounts;
    let state: RoomState = load(&a.state.to_account_info())?;
    require!(state.active(&a.authority.key()), PrivateLoanError::NotMember);
    let now = Clock::get()?.unix_timestamp;
    require!(
        expires_at > now && expires_at <= now.saturating_add(MAX_SESSION_SECONDS),
        PrivateLoanError::SessionTooLong
    );
    require!(scope != 0 && scope & !SCOPE_ALL_NONFINANCIAL == 0, PrivateLoanError::SessionScope);

    let anchor_key = a.anchor.key();
    let sponsor = Sponsor {
        anchor: &a.anchor,
        vault: &a.vault,
        magic_program: &a.magic_program,
        permission_program: &a.permission_program,
    };
    let bump = [ctx.bumps.session];
    let seen = TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG;
    sponsor.create_private_record(
        &a.session.to_account_info(),
        &a.session_permission.to_account_info(),
        &[SESSION_SEED, anchor_key.as_ref(), session_key.as_ref(), &bump],
        SessionScope::LEN as u32,
        vec![Member { flags: AUTHORITY_FLAG | seen, pubkey: a.authority.key() }],
    )?;
    store(
        &a.session.to_account_info(),
        &SessionScope { anchor: anchor_key, authority: a.authority.key(), session_key, expires_at, scope, revoked: false },
    )
}

pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
    let info = ctx.accounts.session.to_account_info();
    let mut s: SessionScope = load(&info)?;
    require_keys_eq!(s.authority, ctx.accounts.authority.key(), PrivateLoanError::Unauthorized);
    s.revoked = true;
    store(&info, &s)
}

/// Resolves who is acting: the signer's own wallet, or the wallet behind a
/// valid session that covers `scope` in this room.
pub fn acting_member(
    signer: &Pubkey,
    anchor: &Pubkey,
    session: Option<&AccountInfo>,
    state: &RoomState,
    scope: u32,
) -> Result<Pubkey> {
    let who = match session {
        None => *signer,
        Some(info) => {
            let s: SessionScope = load(info)?;
            require_keys_eq!(s.session_key, *signer, PrivateLoanError::Unauthorized);
            require_keys_eq!(s.anchor, *anchor, PrivateLoanError::SessionScope);
            require!(!s.revoked, PrivateLoanError::SessionRevoked);
            require!(Clock::get()?.unix_timestamp < s.expires_at, PrivateLoanError::SessionExpired);
            require!(s.scope & scope == scope, PrivateLoanError::SessionScope);
            s.authority
        }
    };
    require!(state.active(&who), PrivateLoanError::NotMember);
    Ok(who)
}

pub fn post_message(ctx: Context<PostMessage>, body: Vec<u8>) -> Result<()> {
    require!(!body.is_empty() && body.len() <= MAX_BODY, PrivateLoanError::MessageTooLong);
    let a = &ctx.accounts;
    let state: RoomState = load(&a.state.to_account_info())?;
    let session = a.session.as_ref().map(|s| s.to_account_info());
    let author = acting_member(&a.signer.key(), &a.anchor.key(), session.as_ref(), &state, SCOPE_POST_MESSAGE)?;

    let info = a.thread.to_account_info();
    require_keys_eq!(*info.owner, crate::ID, PrivateLoanError::InvalidRecord);
    let mut data = info.try_borrow_mut_data()?;
    require!(data.len() >= RoomThread::LEN, PrivateLoanError::InvalidRecord);
    let count = u32::from_le_bytes(data[0..4].try_into().unwrap());
    let o = 4 + (count as usize % MAX_MESSAGES) * RoomThread::SLOT;
    data[o..o + 32].copy_from_slice(author.as_ref());
    data[o + 32..o + 40].copy_from_slice(&Clock::get()?.unix_timestamp.to_le_bytes());
    data[o + 40..o + 42].copy_from_slice(&(body.len() as u16).to_le_bytes());
    data[o + 42..o + 42 + MAX_BODY].fill(0);
    data[o + 42..o + 42 + body.len()].copy_from_slice(&body);
    data[0..4].copy_from_slice(&count.saturating_add(1).to_le_bytes());
    Ok(())
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
#[instruction(room_id: [u8; 32])]
pub struct OpenRoom<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + RoomAnchor::INIT_SPACE,
        seeds = [ROOM_SEED, room_id.as_ref()],
        bump,
    )]
    pub anchor: Account<'info, RoomAnchor>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(room_id: [u8; 32])]
pub struct DelegateRoom<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: The room anchor; ownership moves to the delegation program here.
    #[account(mut, del, seeds = [ROOM_SEED, room_id.as_ref()], bump)]
    pub anchor: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitRoom<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub anchor: Account<'info, RoomAnchor>,
    /// CHECK: ER-only `RoomState`, created here.
    #[account(mut, seeds = [ROOM_STATE_SEED, anchor.key().as_ref()], bump)]
    pub state: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `state`, checked by the permission program.
    #[account(mut)]
    pub state_permission: UncheckedAccount<'info>,
    /// CHECK: ER-only `RoomThread`, created here.
    #[account(mut, seeds = [ROOM_THREAD_SEED, anchor.key().as_ref()], bump)]
    pub thread: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `thread`, checked by the permission program.
    #[account(mut)]
    pub thread_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[derive(Accounts)]
pub struct ManageMembers<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub anchor: Account<'info, RoomAnchor>,
    /// CHECK: ER-only `RoomState`, owner checked in `load`.
    #[account(mut, seeds = [ROOM_STATE_SEED, anchor.key().as_ref()], bump)]
    pub state: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `state`.
    #[account(mut)]
    pub state_permission: UncheckedAccount<'info>,
    /// CHECK: ER-only `RoomThread`.
    #[account(mut, seeds = [ROOM_THREAD_SEED, anchor.key().as_ref()], bump)]
    pub thread: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `thread`.
    #[account(mut)]
    pub thread_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[derive(Accounts)]
#[instruction(session_key: Pubkey)]
pub struct CreateSession<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub anchor: Account<'info, RoomAnchor>,
    /// CHECK: ER-only `RoomState`.
    #[account(seeds = [ROOM_STATE_SEED, anchor.key().as_ref()], bump)]
    pub state: UncheckedAccount<'info>,
    /// CHECK: ER-only `SessionScope`, created here.
    #[account(mut, seeds = [SESSION_SEED, anchor.key().as_ref(), session_key.as_ref()], bump)]
    pub session: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `session`.
    #[account(mut)]
    pub session_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[derive(Accounts)]
pub struct RevokeSession<'info> {
    pub authority: Signer<'info>,
    /// CHECK: ER-only `SessionScope`; authority checked in the handler.
    #[account(mut)]
    pub session: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PostMessage<'info> {
    /// The member's wallet, or a session key with `SCOPE_POST_MESSAGE`.
    pub signer: Signer<'info>,
    pub anchor: Account<'info, RoomAnchor>,
    /// CHECK: ER-only `RoomState`.
    #[account(seeds = [ROOM_STATE_SEED, anchor.key().as_ref()], bump)]
    pub state: UncheckedAccount<'info>,
    /// CHECK: ER-only `RoomThread`.
    #[account(mut, seeds = [ROOM_THREAD_SEED, anchor.key().as_ref()], bump)]
    pub thread: UncheckedAccount<'info>,
    /// CHECK: Optional ER-only `SessionScope`, validated in `acting_member`.
    pub session: Option<UncheckedAccount<'info>>,
}
