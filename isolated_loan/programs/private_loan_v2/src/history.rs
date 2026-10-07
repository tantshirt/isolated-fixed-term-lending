//! Private repayment history and its rollup-signed attestation (Story 26.7).
//!
//! **History (ER-only).** `CreditHistory` at `["credit-history", borrower]` lives only in the
//! rollup, readable only by the borrower (its ephemeral permission names the borrower alone). It
//! is built from settled `LoanTerms`, the same records `publish_receipt` hashes into receipts:
//! anyone (the borrower, a lender, the watcher) may add a settled loan once with
//! `record_history`, so a lender can record a default the borrower would rather leave out. The
//! borrower cannot remove an entry.
//!
//! **Attestation (base layer).** `attest_history` (borrower-signed, in the rollup) commits one of
//! the borrower's loan anchors with a post-commit Magic Action that writes `HistoryAttestation` at
//! `["credit-attestation", borrower]` on Solana: the counts, the rollup slot and time, and a
//! version. Only the delegation program's escrow PDA for a `private_loan_v2` loan anchor can sign
//! `record_history_attestation`, and only `private_loan_v2` can schedule an action for its own
//! anchor PDA, so an account owned by this program at that address was written by this program
//! inside the rollup. An on-chain consumer (Arcium in Phase 9) checks owner, PDA and version.
//!
//! The attestation is public: the borrower chooses to publish their counts. No amounts, lenders,
//! terms or loan ids appear in it.

use crate::constants::{LOAN_SEED, LOAN_TERMS_SEED};
use crate::error::PrivateLoanError;
use crate::loan::{
    create_loan_record, LoanAnchor, LoanTerms, STATUS_LIQUIDATED, STATUS_OVERDUE_LIQUIDATED, STATUS_PRICED_RECOVERED,
    STATUS_REFINANCED, STATUS_REPAID, STATUS_TERMINAL_CLAIMED,
};
use crate::receipt::ACTION_ESCROW_INDEX;
use crate::room::{load, store};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::structs::{Member, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG};
use ephemeral_rollups_sdk::anchor::{action, commit, MagicProgram, PermissionProgram};
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use ephemeral_rollups_sdk::ephem::{CallHandler, FoldableIntentBuilder, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};

pub const HISTORY_SEED: &[u8] = b"credit-history";
pub const HISTORY_ATTESTATION_SEED: &[u8] = b"credit-attestation";
pub const HISTORY_VERSION: u8 = 1;
pub const HISTORY_ATTESTATION_VERSION: u8 = 1;
/// Loans one history can hold. A borrower past this needs a follow-up (paged history).
pub const MAX_HISTORY_LOANS: usize = 32;

/// How a settled loan counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Repaid at or before maturity.
    OnTime,
    /// Repaid after maturity (in grace, or later before any recovery executed).
    Late,
    /// Risk liquidation in the active term or grace.
    Liquidated,
    /// Overdue liquidation, priced recovery or terminal claim: any recovery after grace.
    Defaulted,
    /// Moved into a new loan; never a repayment.
    Refinanced,
}

/// Outcome of a settled loan, or `None` while it is open or if it never started (draft, funded,
/// active, cancelled).
pub fn outcome(t: &LoanTerms) -> Option<Outcome> {
    match t.status {
        STATUS_REPAID => {
            let maturity = t.start_ts.checked_add(t.duration_seconds)?;
            Some(if t.settled_ts <= maturity { Outcome::OnTime } else { Outcome::Late })
        }
        STATUS_LIQUIDATED => Some(Outcome::Liquidated),
        STATUS_OVERDUE_LIQUIDATED | STATUS_PRICED_RECOVERED | STATUS_TERMINAL_CLAIMED => Some(Outcome::Defaulted),
        STATUS_REFINANCED => Some(Outcome::Refinanced),
        _ => None,
    }
}

/// ER-only. Serialized without a discriminator, like `LoanTerms`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct CreditHistory {
    pub version: u8,
    pub borrower: Pubkey,
    pub on_time: u32,
    pub late: u32,
    pub liquidated: u32,
    pub defaulted: u32,
    pub refinanced: u32,
    /// Latest `settled_ts` among counted loans.
    pub last_settled_at: i64,
    pub count: u16,
    /// Loan anchors already counted, so each loan counts once.
    pub counted: [Pubkey; MAX_HISTORY_LOANS],
    pub bump: u8,
}

impl CreditHistory {
    pub const LEN: usize = 1 + 32 + 4 * 5 + 8 + 2 + 32 * MAX_HISTORY_LOANS + 1;

    pub fn new(borrower: Pubkey, bump: u8) -> Self {
        CreditHistory {
            version: HISTORY_VERSION,
            borrower,
            on_time: 0,
            late: 0,
            liquidated: 0,
            defaulted: 0,
            refinanced: 0,
            last_settled_at: 0,
            count: 0,
            counted: [Pubkey::default(); MAX_HISTORY_LOANS],
            bump,
        }
    }

    pub fn repaid(&self) -> u32 {
        self.on_time.saturating_add(self.late)
    }

    /// Adds one settled loan once.
    pub fn add(&mut self, loan: Pubkey, t: &LoanTerms) -> Result<()> {
        require_keys_eq!(t.borrower, self.borrower, PrivateLoanError::NotBorrower);
        let o = outcome(t).ok_or(PrivateLoanError::WrongStatus)?;
        let n = self.count as usize;
        require!(!self.counted[..n].contains(&loan), PrivateLoanError::HistoryAlreadyCounted);
        require!(n < MAX_HISTORY_LOANS, PrivateLoanError::HistoryFull);
        let slot = match o {
            Outcome::OnTime => &mut self.on_time,
            Outcome::Late => &mut self.late,
            Outcome::Liquidated => &mut self.liquidated,
            Outcome::Defaulted => &mut self.defaulted,
            Outcome::Refinanced => &mut self.refinanced,
        };
        *slot = slot.checked_add(1).ok_or(PrivateLoanError::MathOverflow)?;
        self.counted[n] = loan;
        self.count += 1;
        self.last_settled_at = self.last_settled_at.max(t.settled_ts);
        Ok(())
    }
}

/// Base layer, program-owned. Written only by the post-commit action scheduled by `attest_history`.
#[account]
#[derive(InitSpace)]
pub struct HistoryAttestation {
    pub version: u8,
    pub borrower: Pubkey,
    /// `on_time + late`.
    pub repaid: u32,
    pub on_time: u32,
    pub late: u32,
    pub liquidated: u32,
    pub defaulted: u32,
    /// Loans counted in the history (including refinanced ones, which count as nothing else).
    pub loans_counted: u16,
    /// Rollup slot and time at which the counts were read. Zero until the first attestation.
    pub rollup_slot: u64,
    pub attested_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct HistoryAttestationArgs {
    pub borrower: Pubkey,
    /// The loan anchor used as the action's escrow authority, named by its seeds.
    pub anchor_creator: Pubkey,
    pub anchor_nonce: u64,
    pub repaid: u32,
    pub on_time: u32,
    pub late: u32,
    pub liquidated: u32,
    pub defaulted: u32,
    pub loans_counted: u16,
    pub rollup_slot: u64,
    pub attested_at: i64,
}

/// Ephemeral rollup. Anyone adds one settled loan to its borrower's history, once. The first call
/// for a borrower creates the record (sponsored by this loan's anchor) and its permission, which
/// names only the borrower.
pub fn record_history(ctx: Context<RecordHistory>) -> Result<()> {
    let a = &ctx.accounts;
    let t: LoanTerms = load(&a.terms.to_account_info())?;
    require!(outcome(&t).is_some(), PrivateLoanError::WrongStatus);
    let (key, bump) = Pubkey::find_program_address(&[HISTORY_SEED, t.borrower.as_ref()], &crate::ID);
    require_keys_eq!(a.history.key(), key, PrivateLoanError::InvalidRecord);
    let info = a.history.to_account_info();
    let mut h = if info.data_is_empty() {
        let (Some(permission), Some(vault), Some(magic), Some(perm_program)) =
            (a.history_permission.as_ref(), a.vault.as_ref(), a.magic_program.as_ref(), a.permission_program.as_ref())
        else {
            return err!(PrivateLoanError::InvalidRecord);
        };
        let seen = TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG;
        create_loan_record(
            &a.anchor,
            &info,
            &permission.to_account_info(),
            &[HISTORY_SEED, t.borrower.as_ref(), &[bump]],
            CreditHistory::LEN as u32,
            vec![Member { flags: seen, pubkey: t.borrower }],
            &vault.to_account_info(),
            &magic.to_account_info(),
            &perm_program.to_account_info(),
        )?;
        CreditHistory::new(t.borrower, bump)
    } else {
        load::<CreditHistory>(&info)?
    };
    require!(h.version == HISTORY_VERSION && h.bump == bump, PrivateLoanError::InvalidRecord);
    h.add(a.anchor.key(), &t)?;
    store(&info, &h)
}

/// Ephemeral rollup. The borrower publishes their current counts to `HistoryAttestation` on
/// Solana through a post-commit action on one of their loan anchors.
#[inline(never)]
fn attestation_args(a: &AttestHistory) -> Result<HistoryAttestationArgs> {
    let borrower = a.borrower.key();
    let t: LoanTerms = load(&a.terms.to_account_info())?;
    require_keys_eq!(t.borrower, borrower, PrivateLoanError::NotBorrower);
    let (key, _) = Pubkey::find_program_address(&[HISTORY_SEED, borrower.as_ref()], &crate::ID);
    require_keys_eq!(a.history.key(), key, PrivateLoanError::InvalidRecord);
    let h: CreditHistory = load(&a.history.to_account_info())?;
    require_keys_eq!(h.borrower, borrower, PrivateLoanError::NotBorrower);
    let clock = Clock::get()?;
    let anchor = &a.anchor;
    Ok(HistoryAttestationArgs {
        borrower,
        anchor_creator: anchor.creator,
        anchor_nonce: anchor.nonce,
        repaid: h.repaid(),
        on_time: h.on_time,
        late: h.late,
        liquidated: h.liquidated,
        defaulted: h.defaulted,
        loans_counted: h.count,
        rollup_slot: clock.slot,
        attested_at: clock.unix_timestamp,
    })
}

pub fn attest_history(ctx: Context<AttestHistory>) -> Result<()> {
    let a = &ctx.accounts;
    // Keep the large ER records out of the Magic Intent builder's SBF stack frame.
    let args = attestation_args(a)?;
    let anchor = &a.anchor;
    let data = anchor_lang::InstructionData::data(&crate::instruction::RecordHistoryAttestation { args });
    let mut anchor_signer = a.anchor.to_account_info();
    anchor_signer.is_signer = true;
    let action = CallHandler {
        destination_program: crate::ID,
        accounts: vec![
            ShortAccountMeta { pubkey: a.attestation.key(), is_writable: true },
            ShortAccountMeta { pubkey: a.anchor.key(), is_writable: false },
        ],
        args: ActionArgs::new(data),
        escrow_authority: anchor_signer.clone(),
        compute_units: 60_000,
    };
    let nonce = anchor.nonce.to_le_bytes();
    let seeds: &[&[u8]] = &[LOAN_SEED, anchor.creator.as_ref(), &nonce, core::slice::from_ref(&anchor.bump)];
    MagicIntentBundleBuilder::new(a.borrower.to_account_info(), a.magic_context.to_account_info(), a.magic_program.to_account_info())
        .commit(&[anchor_signer])
        .add_post_commit_actions([action])
        .build_and_invoke_signed(&[seeds])?;
    Ok(())
}

/// Base layer. The borrower creates their (empty) attestation account once.
pub fn open_history_attestation(ctx: Context<OpenHistoryAttestation>) -> Result<()> {
    let at = &mut ctx.accounts.attestation;
    at.version = HISTORY_ATTESTATION_VERSION;
    at.borrower = ctx.accounts.borrower.key();
    at.bump = ctx.bumps.attestation;
    Ok(())
}

/// Base layer, Magic Action only. Writes newer counts; an older rollup slot is refused.
pub fn record_history_attestation(ctx: Context<RecordHistoryAttestation>, args: HistoryAttestationArgs) -> Result<()> {
    let (anchor, _) = Pubkey::find_program_address(&[LOAN_SEED, args.anchor_creator.as_ref(), &args.anchor_nonce.to_le_bytes()], &crate::ID);
    require_keys_eq!(ctx.accounts.anchor.key(), anchor, PrivateLoanError::Unauthorized);
    require!(args.repaid == args.on_time.saturating_add(args.late), PrivateLoanError::InvalidRecord);
    let at = &mut ctx.accounts.attestation;
    require!(args.rollup_slot > at.rollup_slot, PrivateLoanError::AlreadyAnswered);
    at.version = HISTORY_ATTESTATION_VERSION;
    at.repaid = args.repaid;
    at.on_time = args.on_time;
    at.late = args.late;
    at.liquidated = args.liquidated;
    at.defaulted = args.defaulted;
    at.loans_counted = args.loans_counted;
    at.rollup_slot = args.rollup_slot;
    at.attested_at = args.attested_at;
    emit!(HistoryAttested { borrower: args.borrower, repaid: args.repaid, defaulted: args.defaulted, rollup_slot: args.rollup_slot });
    Ok(())
}

#[derive(Accounts)]
pub struct RecordHistory<'info> {
    pub caller: Signer<'info>,
    /// Sponsors the history record on its first write.
    #[account(mut, seeds = [LOAN_SEED, anchor.creator.as_ref(), &anchor.nonce.to_le_bytes()], bump = anchor.bump)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`; loaded and owner-checked in the handler.
    #[account(seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: ER-only `CreditHistory` of the loan's borrower; address checked in the handler.
    #[account(mut)]
    pub history: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `history` (first write only).
    #[account(mut)]
    pub history_permission: Option<UncheckedAccount<'info>>,
    /// CHECK: Fixed ephemeral rent vault (first write only).
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: Option<UncheckedAccount<'info>>,
    pub magic_program: Option<Program<'info, MagicProgram>>,
    pub permission_program: Option<Program<'info, PermissionProgram>>,
}

#[commit]
#[derive(Accounts)]
pub struct AttestHistory<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    /// Any of the borrower's loan anchors: committed, and the action's escrow authority.
    #[account(mut, seeds = [LOAN_SEED, anchor.creator.as_ref(), &anchor.nonce.to_le_bytes()], bump = anchor.bump)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms` of `anchor`; its borrower must be the signer.
    #[account(seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: ER-only `CreditHistory`; address checked in the handler.
    pub history: UncheckedAccount<'info>,
    /// CHECK: The base-layer attestation PDA; written by the post-commit action.
    #[account(seeds = [HISTORY_ATTESTATION_SEED, borrower.key().as_ref()], bump)]
    pub attestation: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OpenHistoryAttestation<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(init, payer = borrower, space = 8 + HistoryAttestation::INIT_SPACE, seeds = [HISTORY_ATTESTATION_SEED, borrower.key().as_ref()], bump)]
    pub attestation: Account<'info, HistoryAttestation>,
    pub system_program: Program<'info, System>,
}

#[action]
#[derive(Accounts)]
#[instruction(args: HistoryAttestationArgs)]
pub struct RecordHistoryAttestation<'info> {
    #[account(
        mut,
        seeds = [HISTORY_ATTESTATION_SEED, args.borrower.as_ref()],
        bump = attestation.bump,
        constraint = attestation.borrower == args.borrower @ PrivateLoanError::InvalidRecord,
    )]
    pub attestation: Account<'info, HistoryAttestation>,
    /// CHECK: A `private_loan_v2` loan anchor, derived from `args` in the handler.
    pub anchor: UncheckedAccount<'info>,
    /// CHECK: The delegation program passes the destination program next.
    #[account(address = crate::ID @ PrivateLoanError::Unauthorized)]
    pub destination_program: UncheckedAccount<'info>,
    /// CHECK: The identity the action was scheduled with: the loan anchor PDA, which only this
    /// program can sign for.
    #[account(address = anchor.key() @ PrivateLoanError::Unauthorized)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: Only the delegation program can sign for this PDA.
    #[account(
        signer,
        address = ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer(&escrow_auth.key(), ACTION_ESCROW_INDEX) @ PrivateLoanError::Unauthorized,
    )]
    pub escrow: UncheckedAccount<'info>,
}

#[event]
pub struct HistoryAttested {
    pub borrower: Pubkey,
    pub repaid: u32,
    pub defaulted: u32,
    pub rollup_slot: u64,
}
