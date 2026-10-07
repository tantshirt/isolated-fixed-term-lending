//! Settlement receipts through Magic Actions (Epic 12.2).
//!
//! After a private loan settles, anyone can call `publish_receipt` inside the
//! ER. It commits the loan anchor, which holds no terms, and attaches a
//! post-commit action that writes a minimal `SettlementReceipt` on Solana: the
//! outcome and an opaque commitment (SHA-256 of the final terms record). The
//! commitment references state; it does not prove the calculation.
//!
//! The base-layer handler only accepts calls signed by the delegation
//! program's escrow PDA for this loan anchor, so a direct or foreign-scheduled
//! call fails. A receipt is written once.

use crate::constants::{LOAN_SEED, LOAN_TERMS_SEED, RECEIPT_SEED};
use crate::error::PrivateLoanError;
use crate::loan::{LoanAnchor, LoanTerms, STATUS_ACTIVE, STATUS_DRAFT, STATUS_FUNDED};
use crate::room::load;
use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;
use ephemeral_rollups_sdk::anchor::{action, commit};
use ephemeral_rollups_sdk::ephem::{CallHandler, FoldableIntentBuilder, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};

pub const ACTION_ESCROW_INDEX: u8 = 255;

#[account]
#[derive(InitSpace)]
pub struct SettlementReceipt {
    pub loan: Pubkey,
    /// 0 until published; then the final loan status.
    pub status: u8,
    pub commitment: [u8; 32],
    pub settled_at: i64,
    pub bump: u8,
}

pub fn publish_receipt(ctx: Context<PublishReceipt>) -> Result<()> {
    let a = &ctx.accounts;
    let terms_info = a.terms.to_account_info();
    let t: LoanTerms = load(&terms_info)?;
    require!(
        t.status != STATUS_DRAFT && t.status != STATUS_FUNDED && t.status != STATUS_ACTIVE,
        PrivateLoanError::WrongStatus
    );
    let commitment = hash(&terms_info.try_borrow_data()?).to_bytes();
    let data = anchor_lang::InstructionData::data(&crate::instruction::RecordReceipt {
        status: t.status,
        commitment,
        settled_at: Clock::get()?.unix_timestamp,
    });
    // The intent builder copies each AccountInfo's `is_signer` into the CPI metas, so
    // the PDA must be marked as a signer here for `invoke_signed` to sign for it.
    let mut anchor_signer = a.anchor.to_account_info();
    anchor_signer.is_signer = true;
    let action = CallHandler {
        destination_program: crate::ID,
        accounts: vec![
            ShortAccountMeta { pubkey: a.receipt.key(), is_writable: true },
            ShortAccountMeta { pubkey: a.anchor.key(), is_writable: false },
        ],
        args: ActionArgs::new(data),
        escrow_authority: anchor_signer.clone(),
        compute_units: 60_000,
    };
    let anchor = &a.anchor;
    let nonce = anchor.nonce.to_le_bytes();
    let seeds: &[&[u8]] = &[LOAN_SEED, anchor.creator.as_ref(), &nonce, core::slice::from_ref(&anchor.bump)];
    MagicIntentBundleBuilder::new(
        a.publisher.to_account_info(),
        a.magic_context.to_account_info(),
        a.magic_program.to_account_info(),
    )
    .commit(&[anchor_signer])
    .add_post_commit_actions([action])
    .build_and_invoke_signed(&[seeds])?;
    Ok(())
}

/// Base layer, action-only.
pub fn record_receipt(ctx: Context<RecordReceipt>, status: u8, commitment: [u8; 32], settled_at: i64) -> Result<()> {
    let r = &mut ctx.accounts.receipt;
    require!(r.status == 0, PrivateLoanError::AlreadyAnswered);
    r.status = status;
    r.commitment = commitment;
    r.settled_at = settled_at;
    Ok(())
}

#[commit]
#[derive(Accounts)]
pub struct PublishReceipt<'info> {
    #[account(mut)]
    pub publisher: Signer<'info>,
    #[account(mut)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`; read and hashed in the handler.
    #[account(seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: The base-layer receipt PDA; written by the post-commit action.
    #[account(seeds = [RECEIPT_SEED, anchor.key().as_ref()], bump)]
    pub receipt: UncheckedAccount<'info>,
}

#[action]
#[derive(Accounts)]
pub struct RecordReceipt<'info> {
    #[account(mut, seeds = [RECEIPT_SEED, anchor.key().as_ref()], bump = receipt.bump, constraint = receipt.loan == anchor.key() @ PrivateLoanError::InvalidRecord)]
    pub receipt: Account<'info, SettlementReceipt>,
    /// CHECK: The loan anchor (owned by the delegation program while delegated).
    pub anchor: UncheckedAccount<'info>,
    /// CHECK: The delegation program passes the destination program next (observed
    /// on Devnet: [action accounts…, program id, escrow_auth, escrow]).
    #[account(address = crate::ID @ PrivateLoanError::Unauthorized)]
    pub destination_program: UncheckedAccount<'info>,
    /// CHECK: The identity the action was scheduled with; must be this loan's anchor,
    /// so only an action `publish_receipt` scheduled for this loan can write it.
    #[account(address = anchor.key() @ PrivateLoanError::Unauthorized)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: Only the delegation program can sign for this PDA, so the signature
    /// proves the call came through the real post-commit path.
    #[account(
        signer,
        address = ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer(&escrow_auth.key(), ACTION_ESCROW_INDEX) @ PrivateLoanError::Unauthorized,
    )]
    pub escrow: UncheckedAccount<'info>,
}
