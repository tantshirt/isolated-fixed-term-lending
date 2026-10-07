//! Private loans (Epic 10; V2: Stories 22.1, 22.2).
//!
//! `LoanAnchor` is delegated and owns the loan's USDC and wSOL eATAs, so each loan's custody is
//! separate. Exact terms, parties, approvals, accounting and status live in an ER-only
//! `LoanTerms` record readable only by the lender and borrower; committed accounts are plaintext
//! on Solana (gate 8.7), so terms never are.
//!
//! V2: anchors are namespaced by their creator and a nonce; a room can hold many loans, each
//! with a sequential room index and an ER-only registry entry; one proposal is accepted per
//! borrowing request (`request_index`), not per room; and every loan carries the shared V2
//! ledger (`loan_core::accounting`) with partial repayment, top-up, grace and recovery.

use crate::constants::{LOAN_SEED, LOAN_TERMS_SEED, ROOM_DEAL_SEED, ROOM_LOAN_SEED, ROOM_STATE_SEED, TEE_VALIDATOR};
use crate::error::{core_error, PrivateLoanError};
use crate::espl::{self, ESPL_PROGRAM_ID};
use crate::room::{load, store, RoomAnchor, RoomState, ROLE_BORROWER, ROLE_LENDER};
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::access_control::instructions::CreateEphemeralPermissionCpi;
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, Member, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::anchor::{delegate, MagicProgram, PermissionProgram};
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;
use loan_core::accounting::{self as acc, EarlyRepayment, Ledger, TermsV2};
use loan_core::math;

pub const LOAN_SPONSOR_LAMPORTS: u64 = 10_000_000;

pub const STATUS_DRAFT: u8 = 0;
pub const STATUS_FUNDED: u8 = 1;
pub const STATUS_ACTIVE: u8 = 2;
pub const STATUS_REPAID: u8 = 3;
pub const STATUS_CANCELLED: u8 = 5;
pub const STATUS_LIQUIDATED: u8 = 6;
pub const STATUS_OVERDUE_LIQUIDATED: u8 = 7;
pub const STATUS_PRICED_RECOVERED: u8 = 8;
pub const STATUS_TERMINAL_CLAIMED: u8 = 9;
/// Moved into a new loan by `refinance` (Story 26.1); never counted as a repayment.
pub const STATUS_REFINANCED: u8 = 10;

#[account]
#[derive(InitSpace)]
pub struct LoanAnchor {
    pub version: u8,
    /// The lender who created the anchor and signs its first private setup.
    pub creator: Pubkey,
    pub nonce: u64,
    /// Room the loan was agreed in. An opaque id; it names no wallet.
    pub room: Pubkey,
    pub usdc_mint: Pubkey,
    pub wsol_mint: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct TermsArgs {
    pub borrower: Pubkey,
    /// The borrowing request in the room this proposal answers. One proposal per request is accepted.
    pub request_index: u32,
    pub principal: u64,
    pub interest_bps: u16,
    pub duration_seconds: i64,
    pub early_repayment: u8,
    pub min_interest_bps: u16,
    pub grace_seconds: i64,
    pub late_fee_bps: u16,
    pub annual_ceiling_bps: u16,
    pub collateral_amount: u64,
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct LedgerState {
    pub outstanding_principal: u64,
    pub interest_accrued: u64,
    pub interest_paid: u64,
    pub accrual_remainder: u128,
    pub last_accrual_ts: i64,
    pub late_fee_assessed: u64,
    pub late_fee_paid: u64,
    pub late_fee_checked: bool,
}

impl From<Ledger> for LedgerState {
    fn from(l: Ledger) -> Self {
        Self {
            outstanding_principal: l.outstanding_principal,
            interest_accrued: l.interest_accrued,
            interest_paid: l.interest_paid,
            accrual_remainder: l.accrual_remainder,
            last_accrual_ts: l.last_accrual_ts,
            late_fee_assessed: l.late_fee_assessed,
            late_fee_paid: l.late_fee_paid,
            late_fee_checked: l.late_fee_checked,
        }
    }
}

impl From<LedgerState> for Ledger {
    fn from(l: LedgerState) -> Self {
        Self {
            outstanding_principal: l.outstanding_principal,
            interest_accrued: l.interest_accrued,
            interest_paid: l.interest_paid,
            accrual_remainder: l.accrual_remainder,
            last_accrual_ts: l.last_accrual_ts,
            late_fee_assessed: l.late_fee_assessed,
            late_fee_paid: l.late_fee_paid,
            late_fee_checked: l.late_fee_checked,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct LoanTerms {
    pub version: u8,
    /// Immutable: the lender that originated the loan.
    pub origin_lender: Pubkey,
    /// Receives payments and claims; changes only through a future sale.
    pub current_lender: Pubkey,
    pub borrower: Pubkey,
    pub room_index: u32,
    pub request_index: u32,
    pub principal: u64,
    pub interest_bps: u16,
    pub duration_seconds: i64,
    pub early_repayment: u8,
    pub min_interest_bps: u16,
    pub grace_seconds: i64,
    pub late_fee_bps: u16,
    pub annual_ceiling_bps: u16,
    pub collateral_required: u64,
    pub collateral_locked: u64,
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
    /// Bumped on every financial edit; approvals bind to a revision.
    pub revision: u32,
    pub funded_revision: u32,
    pub accepted_revision: u32,
    pub status: u8,
    pub start_ts: i64,
    pub ledger: LedgerState,
    /// Bumped whenever the ledger or collateral changes, so open liquidation quotes go stale.
    pub ledger_revision: u32,
    pub shortfall: u64,
    pub settled_ts: i64,
    /// Desk the loan was originated under (Epic 23); default when none.
    pub desk: Pubkey,
    pub policy_version: u32,
    /// SHA-256 of the consented auditor list (Story 24.1); zero when none.
    pub auditor_hash: [u8; 32],
}

impl LoanTerms {
    pub const LEN: usize = 1 + 32 * 3 + 4 + 4 + 8 + 2 + 8 + 1 + 2 + 8 + 2 + 2 + 8 + 8 + 2 + 2 + 4 * 3 + 1 + 8
        + (8 * 3 + 16 + 8 + 8 + 8 + 1)
        + 4 + 8 + 8 + 32 + 4 + 32;

    pub fn core_terms(&self) -> Result<TermsV2> {
        Ok(TermsV2 {
            principal: self.principal,
            interest_bps: self.interest_bps,
            duration: self.duration_seconds,
            start_ts: self.start_ts,
            early_repayment: EarlyRepayment::from_u8(self.early_repayment).map_err(core_error)?,
            min_interest_bps: self.min_interest_bps,
            grace_seconds: self.grace_seconds,
            late_fee_bps: self.late_fee_bps,
            annual_ceiling_bps: self.annual_ceiling_bps,
        })
    }

    pub fn payoff(&self, now: i64) -> Result<u64> {
        acc::payoff(&self.core_terms()?, &self.ledger.into(), now).map_err(core_error)
    }

    fn apply(&mut self, a: &TermsArgs, now: i64) -> Result<()> {
        require!(a.principal > 0 && a.collateral_amount > 0, PrivateLoanError::InvalidTerms);
        math::validate_terms(a.interest_bps, a.duration_seconds, a.max_ltv_bps, a.liquidation_ltv_bps).map_err(core_error)?;
        self.borrower = a.borrower;
        self.principal = a.principal;
        self.interest_bps = a.interest_bps;
        self.duration_seconds = a.duration_seconds;
        self.early_repayment = a.early_repayment;
        self.min_interest_bps = a.min_interest_bps;
        self.grace_seconds = a.grace_seconds;
        self.late_fee_bps = a.late_fee_bps;
        self.annual_ceiling_bps = a.annual_ceiling_bps;
        self.collateral_required = a.collateral_amount;
        self.max_ltv_bps = a.max_ltv_bps;
        self.liquidation_ltv_bps = a.liquidation_ltv_bps;
        let mut t = self.core_terms()?;
        t.start_ts = now;
        t.validate().map_err(core_error)
    }

    pub(crate) fn settle(&mut self, status: u8, now: i64) {
        self.status = status;
        self.settled_ts = now;
        self.collateral_locked = 0;
        self.ledger_revision = self.ledger_revision.saturating_add(1);
    }
}

pub(crate) fn require_ata(account: &AccountInfo, owner: &Pubkey, mint: &Pubkey) -> Result<()> {
    require_keys_eq!(account.key(), get_associated_token_address(owner, mint), PrivateLoanError::WrongTokenAccount);
    Ok(())
}

pub(crate) fn transfer<'info>(
    token_program: &Program<'info, Token>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    seeds: Option<&[&[u8]]>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accounts = Transfer { from: from.clone(), to: to.clone(), authority: authority.clone() };
    match seeds {
        Some(s) => token::transfer(CpiContext::new_with_signer(token_program.key(), accounts, &[s]), amount),
        None => token::transfer(CpiContext::new(token_program.key(), accounts), amount),
    }
}

/// Creates an ER-only record paid for and permission-signed by the loan anchor.
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_loan_record<'info>(
    anchor: &Account<'info, LoanAnchor>,
    record: &AccountInfo<'info>,
    permission: &AccountInfo<'info>,
    record_seeds: &[&[u8]],
    len: u32,
    members: Vec<Member>,
    vault: &AccountInfo<'info>,
    magic_program: &AccountInfo<'info>,
    permission_program: &AccountInfo<'info>,
) -> Result<()> {
    let anchor_info = anchor.to_account_info();
    let nonce = anchor.nonce.to_le_bytes();
    let seeds: [&[u8]; 4] = [LOAN_SEED, anchor.creator.as_ref(), &nonce, core::slice::from_ref(&anchor.bump)];
    EphemeralAccount::new(&anchor_info, record, vault)
        .with_signer_seeds(&[&seeds, record_seeds])
        .create(len)?;
    CreateEphemeralPermissionCpi {
        permissioned_account: record.clone(),
        permission: permission.clone(),
        payer: anchor_info,
        vault: vault.clone(),
        magic_program: magic_program.clone(),
        permission_program: permission_program.clone(),
        args: EphemeralMembersArgs { is_private: true, members },
    }
    .invoke_signed(&[&seeds, record_seeds])?;
    Ok(())
}

macro_rules! loan_signer {
    ($anchor:expr, $nonce:ident, $seeds:ident) => {
        let $nonce = $anchor.nonce.to_le_bytes();
        let $seeds: [&[u8]; 4] = [$crate::constants::LOAN_SEED, $anchor.creator.as_ref(), &$nonce, core::slice::from_ref(&$anchor.bump)];
    };
}
pub(crate) use loan_signer;

// ---------------------------------------------------------------- base layer

/// Creates the loan anchor, its two empty eATAs, and delegates the eATAs. The signer becomes the
/// anchor's immutable creator; only they can set up its private terms.
pub fn create_loan(ctx: Context<CreateLoan>, nonce: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.usdc_mint.decimals == 6, PrivateLoanError::InvalidTerms);
    require!(a.wsol_mint.decimals == 9, PrivateLoanError::InvalidTerms);
    require!(
        loan_core::constants::mints_allowed(&a.usdc_mint.key(), &a.wsol_mint.key()),
        PrivateLoanError::MintNotAllowed
    );
    let anchor = &mut ctx.accounts.anchor;
    anchor.version = 2;
    anchor.creator = ctx.accounts.lender.key();
    anchor.nonce = nonce;
    anchor.room = ctx.accounts.room.key();
    anchor.usdc_mint = ctx.accounts.usdc_mint.key();
    anchor.wsol_mint = ctx.accounts.wsol_mint.key();
    anchor.bump = ctx.bumps.anchor;
    let receipt = &mut ctx.accounts.receipt;
    receipt.loan = ctx.accounts.anchor.key();
    receipt.bump = ctx.bumps.receipt;

    let a = &ctx.accounts;
    system_program::transfer(
        CpiContext::new(
            a.system_program.key(),
            system_program::Transfer { from: a.lender.to_account_info(), to: a.anchor.to_account_info() },
        ),
        LOAN_SPONSOR_LAMPORTS,
    )?;
    let anchor_info = a.anchor.to_account_info();
    for (eata, mint, buffer, record, metadata) in [
        (&a.usdc_eata, a.usdc_mint.to_account_info(), &a.usdc_buffer, &a.usdc_record, &a.usdc_metadata),
        (&a.wsol_eata, a.wsol_mint.to_account_info(), &a.wsol_buffer, &a.wsol_record, &a.wsol_metadata),
    ] {
        espl::initialize_ephemeral_ata(&a.espl_program, eata, &a.lender, &anchor_info, &mint, &a.system_program)?;
        espl::delegate(&a.espl_program, &a.lender, eata, buffer, record, metadata, &a.delegation_program, &a.system_program, TEE_VALIDATOR)?;
    }
    Ok(())
}

/// Sent in the same transaction as `create_loan`.
pub fn delegate_loan(ctx: Context<DelegateLoan>, nonce: u64) -> Result<()> {
    let lender = ctx.accounts.lender.key();
    let nonce = nonce.to_le_bytes();
    ctx.accounts.delegate_anchor(
        &ctx.accounts.lender,
        &[LOAN_SEED, lender.as_ref(), &nonce],
        DelegateConfig { validator: Some(TEE_VALIDATOR), ..Default::default() },
    )?;
    Ok(())
}

// ------------------------------------------------------------- ephemeral rollup

/// Initial private setup. Requires the anchor's creator, binds the loan to its room, checks both
/// roles (no owner bypass), allocates the next room index atomically and records it in the
/// room's registry.
pub fn propose_terms(ctx: Context<ProposeTerms>, args: TermsArgs) -> Result<()> {
    let a = &ctx.accounts;
    let lender = a.lender.key();
    require_keys_eq!(a.anchor.creator, lender, PrivateLoanError::NotLender);
    require_keys_eq!(a.anchor.room, a.room.key(), PrivateLoanError::WrongRoom);
    let state_info = a.room_state.to_account_info();
    let mut room: RoomState = load(&state_info)?;
    require!(room.has_role(&lender, ROLE_LENDER), PrivateLoanError::NotLender);
    require!(room.has_role(&args.borrower, ROLE_BORROWER), PrivateLoanError::NotBorrower);
    require_keys_neq!(lender, args.borrower, PrivateLoanError::NotBorrower);
    require!(a.terms.data_is_empty(), PrivateLoanError::RoomAlreadyInitialized);
    require!(a.registry.data_is_empty(), PrivateLoanError::InvalidRecord);
    let (registry_key, registry_bump) =
        Pubkey::find_program_address(&[ROOM_LOAN_SEED, a.room.key().as_ref(), &room.next_loan_index.to_le_bytes()], &crate::ID);
    require_keys_eq!(a.registry.key(), registry_key, PrivateLoanError::InvalidRecord);

    let now = Clock::get()?.unix_timestamp;
    let room_index = room.next_loan_index;
    let mut terms = LoanTerms {
        version: 2,
        origin_lender: lender,
        current_lender: lender,
        borrower: args.borrower,
        room_index,
        request_index: args.request_index,
        principal: 0,
        interest_bps: 0,
        duration_seconds: 0,
        early_repayment: 0,
        min_interest_bps: 0,
        grace_seconds: 0,
        late_fee_bps: 0,
        annual_ceiling_bps: 0,
        collateral_required: 0,
        collateral_locked: 0,
        max_ltv_bps: 0,
        liquidation_ltv_bps: 0,
        revision: 1,
        funded_revision: 0,
        accepted_revision: 0,
        status: STATUS_DRAFT,
        start_ts: 0,
        ledger: LedgerState::default(),
        ledger_revision: 0,
        shortfall: 0,
        settled_ts: 0,
        desk: Pubkey::default(),
        policy_version: 0,
        auditor_hash: [0; 32],
    };
    terms.apply(&args, now)?;

    // The index is allocated in the same instruction that records it, so two proposals can
    // never share one.
    room.next_loan_index = room.next_loan_index.checked_add(1).ok_or(PrivateLoanError::MathOverflow)?;
    store(&state_info, &room)?;

    let anchor_key = a.anchor.key();
    let room_key = a.room.key();
    let index = room_index.to_le_bytes();
    let registry_bump = [registry_bump];
    let registry_info = a.registry.to_account_info();
    create_loan_record(
        &a.anchor,
        &registry_info,
        &a.registry_permission.to_account_info(),
        &[ROOM_LOAN_SEED, room_key.as_ref(), &index, &registry_bump],
        32,
        room.permission_members(),
        &a.vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
    )?;
    registry_info.try_borrow_mut_data()?[..32].copy_from_slice(anchor_key.as_ref());

    let terms_info = a.terms.to_account_info();
    let terms_bump = [ctx.bumps.terms];
    let seen = TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG;
    create_loan_record(
        &a.anchor,
        &terms_info,
        &a.terms_permission.to_account_info(),
        &[LOAN_TERMS_SEED, anchor_key.as_ref(), &terms_bump],
        LoanTerms::LEN as u32,
        vec![Member { flags: seen, pubkey: lender }, Member { flags: seen, pubkey: args.borrower }],
        &a.vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
    )?;
    store(&terms_info, &terms)
}

/// Any financial edit bumps the revision, so earlier approvals no longer match.
pub fn edit_terms(ctx: Context<EditTerms>, args: TermsArgs) -> Result<()> {
    let info = ctx.accounts.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    require_keys_eq!(t.current_lender, ctx.accounts.lender.key(), PrivateLoanError::NotLender);
    require_keys_eq!(t.borrower, args.borrower, PrivateLoanError::NotBorrower);
    require!(t.request_index == args.request_index, PrivateLoanError::InvalidTerms);
    require!(t.status == STATUS_DRAFT, PrivateLoanError::WrongStatus);
    t.apply(&args, Clock::get()?.unix_timestamp)?;
    t.revision = t.revision.saturating_add(1);
    store(&info, &t)
}

/// Lender approves `revision` by locking the principal in the loan's custody.
pub fn fund_loan(ctx: Context<LenderMoves>, revision: u32) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    require_keys_eq!(t.current_lender, a.lender.key(), PrivateLoanError::NotLender);
    require!(t.status == STATUS_DRAFT, PrivateLoanError::WrongStatus);
    require!(t.revision == revision, PrivateLoanError::StaleRevision);
    require_ata(&a.lender_usdc, &t.current_lender, &a.anchor.usdc_mint)?;
    require_ata(&a.loan_usdc, &a.anchor.key(), &a.anchor.usdc_mint)?;
    transfer(&a.token_program, &a.lender_usdc, &a.loan_usdc, &a.lender.to_account_info(), None, t.principal)?;
    t.status = STATUS_FUNDED;
    t.funded_revision = revision;
    store(&info, &t)
}

/// Lender withdraws an offer before the borrower accepts it.
pub fn cancel_loan(ctx: Context<LenderMoves>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    require_keys_eq!(t.current_lender, a.lender.key(), PrivateLoanError::NotLender);
    require!(t.status == STATUS_DRAFT || t.status == STATUS_FUNDED, PrivateLoanError::WrongStatus);
    if t.status == STATUS_FUNDED {
        require_ata(&a.lender_usdc, &t.current_lender, &a.anchor.usdc_mint)?;
        require_ata(&a.loan_usdc, &a.anchor.key(), &a.anchor.usdc_mint)?;
        loan_signer!(a.anchor, nonce, seeds);
        transfer(&a.token_program, &a.loan_usdc, &a.lender_usdc, &a.anchor.to_account_info(), Some(&seeds), t.principal)?;
    }
    t.status = STATUS_CANCELLED;
    t.settled_ts = Clock::get()?.unix_timestamp;
    store(&info, &t)
}

/// The optional ER accounts an origination needs: the room deal record and, for desk loans, the
/// pinned policy and the terms permission. Shared by `accept_loan` and `refinance` (Story 26.1).
pub(crate) struct OriginationAccounts<'a, 'info> {
    pub deal: Option<&'a UncheckedAccount<'info>>,
    pub deal_permission: Option<&'a UncheckedAccount<'info>>,
    pub vault: Option<&'a UncheckedAccount<'info>>,
    pub magic_program: Option<&'a Program<'info, MagicProgram>>,
    pub permission_program: Option<&'a Program<'info, PermissionProgram>>,
    pub terms_permission: Option<&'a UncheckedAccount<'info>>,
    pub desk_policy: Option<&'a UncheckedAccount<'info>>,
}

impl<'info> OriginationAccounts<'_, 'info> {
    /// Desk loans re-check the pinned policy; its auditors become read-only members.
    pub(crate) fn desk_auditors(&self, t: &LoanTerms) -> Result<Vec<Pubkey>> {
        if t.desk == Pubkey::default() {
            return Ok(Vec::new());
        }
        let policy_info = self.desk_policy.ok_or(error!(PrivateLoanError::InvalidRecord))?;
        Ok(crate::desk::check_desk_policy(t, &policy_info.to_account_info())?.args.auditors().to_vec())
    }

    /// One accepted proposal per borrowing request: the first acceptance records itself, and any
    /// competing proposal for the same request fails. Other requests in the room are unaffected.
    pub(crate) fn record_deal(&self, anchor: &Account<'info, LoanAnchor>, t: &LoanTerms) -> Result<()> {
        let deal = self.deal.ok_or(error!(PrivateLoanError::InvalidRecord))?;
        let loan_key = anchor.key();
        let request = t.request_index.to_le_bytes();
        let (expected, bump) = Pubkey::find_program_address(&[ROOM_DEAL_SEED, anchor.room.as_ref(), &request], &crate::ID);
        require_keys_eq!(deal.key(), expected, PrivateLoanError::InvalidRecord);
        if deal.data_is_empty() {
            let room = anchor.room;
            let bump = [bump];
            let missing = || error!(PrivateLoanError::InvalidRecord);
            create_loan_record(
                anchor,
                &deal.to_account_info(),
                &self.deal_permission.ok_or_else(missing)?.to_account_info(),
                &[ROOM_DEAL_SEED, room.as_ref(), &request, &bump],
                32,
                vec![Member { flags: TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG, pubkey: t.borrower }],
                &self.vault.ok_or_else(missing)?.to_account_info(),
                &self.magic_program.ok_or_else(missing)?.to_account_info(),
                &self.permission_program.ok_or_else(missing)?.to_account_info(),
            )?;
            deal.to_account_info().try_borrow_mut_data()?[..32].copy_from_slice(loan_key.as_ref());
        } else {
            let d = deal.to_account_info();
            require_keys_eq!(*d.owner, crate::ID, PrivateLoanError::InvalidRecord);
            let accepted = Pubkey::new_from_array(d.try_borrow_data()?[..32].try_into().unwrap());
            require_keys_eq!(accepted, loan_key, PrivateLoanError::CompetingOfferAccepted);
        }
        Ok(())
    }

    /// Adds the consented auditors to the loan's terms permission.
    pub(crate) fn grant_auditors(&self, anchor: &Account<'info, LoanAnchor>, info: &AccountInfo<'info>, t: &LoanTerms, auditors: &[Pubkey]) -> Result<()> {
        if auditors.is_empty() {
            return Ok(());
        }
        let missing = || error!(PrivateLoanError::InvalidRecord);
        let (_, terms_bump) = Pubkey::find_program_address(&[LOAN_TERMS_SEED, anchor.key().as_ref()], &crate::ID);
        crate::desk::set_loan_readers(
            anchor,
            info,
            terms_bump,
            &self.terms_permission.ok_or_else(missing)?.to_account_info(),
            &self.vault.ok_or_else(missing)?.to_account_info(),
            &self.magic_program.ok_or_else(missing)?.to_account_info(),
            &self.permission_program.ok_or_else(missing)?.to_account_info(),
            crate::desk::loan_readers(t, auditors),
        )
    }
}

/// Starts `t` now after the origination LTV check: maximum contractual exposure against the
/// conservative spot value of the required collateral. Returns the started terms.
pub(crate) fn check_origination(t: &mut LoanTerms, price_update: &AccountInfo, clock: &Clock) -> Result<TermsV2> {
    t.start_ts = clock.unix_timestamp;
    let terms = t.core_terms()?;
    terms.validate().map_err(core_error)?;
    let exposure = terms.max_exposure().map_err(core_error)?;
    let price = loan_core::oracle::read_sol_usd_price(price_update, clock).map_err(core_error)?;
    let value = math::collateral_value_usdc(t.collateral_required, price.price, price.conf, price.exponent).map_err(core_error)?;
    let ltv = math::current_ltv_bps(exposure, value).map_err(core_error)?;
    require!(ltv <= t.max_ltv_bps, PrivateLoanError::InsufficientCollateral);
    Ok(terms)
}

/// Borrower approves the same `revision`: collateral in, principal out. Origination LTV uses
/// the maximum contractual exposure. `auditor_hash` is the audience the borrower was shown;
/// for a desk loan it must match the pinned policy, which is checked again here, and the named
/// auditors become read-only members of the loan.
pub fn accept_loan(ctx: Context<BorrowerMoves>, revision: u32, auditor_hash: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    require_keys_eq!(t.borrower, a.borrower.key(), PrivateLoanError::NotBorrower);
    require!(t.status == STATUS_FUNDED, PrivateLoanError::WrongStatus);
    require!(t.revision == revision && t.funded_revision == revision, PrivateLoanError::StaleRevision);
    require!(t.auditor_hash == auditor_hash, PrivateLoanError::AuditorMismatch);
    a.check_accounts(&t)?;
    let er = a.origination();
    let auditors = er.desk_auditors(&t)?;
    er.record_deal(&a.anchor, &t)?;

    let clock = Clock::get()?;
    let terms = check_origination(&mut t, &a.price_update, &clock)?;

    transfer(&a.token_program, &a.borrower_wsol, &a.loan_wsol, &a.borrower.to_account_info(), None, t.collateral_required)?;
    loan_signer!(a.anchor, nonce, seeds);
    transfer(&a.token_program, &a.loan_usdc, &a.borrower_usdc, &a.anchor.to_account_info(), Some(&seeds), t.principal)?;

    t.ledger = acc::open(&terms).map_err(core_error)?.into();
    t.collateral_locked = t.collateral_required;
    t.status = STATUS_ACTIVE;
    t.accepted_revision = revision;
    er.grant_auditors(&a.anchor, &info, &t, &auditors)?;
    store(&info, &t)
}

/// Pays up to `amount`: interest, then late fee, then principal, straight to the current lender.
/// At or above the payoff it closes the loan and returns all collateral. Open in every phase
/// until a settlement executes.
pub fn repay(ctx: Context<BorrowerMoves>, amount: u64) -> Result<()> {
    require!(amount > 0, PrivateLoanError::ZeroAmount);
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    require_keys_eq!(t.borrower, a.borrower.key(), PrivateLoanError::NotBorrower);
    require!(t.status == STATUS_ACTIVE, PrivateLoanError::WrongStatus);
    a.check_accounts(&t)?;
    require_ata(&a.lender_usdc, &t.current_lender, &a.anchor.usdc_mint)?;
    let now = Clock::get()?.unix_timestamp;
    let (ledger, p) = acc::apply_payment(&t.core_terms()?, &t.ledger.into(), now, amount).map_err(core_error)?;
    transfer(&a.token_program, &a.borrower_usdc, &a.lender_usdc, &a.borrower.to_account_info(), None, p.used)?;
    t.ledger = ledger.into();
    t.ledger_revision = t.ledger_revision.saturating_add(1);
    if p.closed {
        loan_signer!(a.anchor, nonce, seeds);
        transfer(&a.token_program, &a.loan_wsol, &a.borrower_wsol, &a.anchor.to_account_info(), Some(&seeds), t.collateral_locked)?;
        t.settle(STATUS_REPAID, now);
    }
    store(&info, &t)
}

/// Borrower adds wSOL. No price is needed; health refreshes at the next valid price.
pub fn add_collateral(ctx: Context<BorrowerMoves>, amount: u64) -> Result<()> {
    require!(amount > 0, PrivateLoanError::ZeroAmount);
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    require_keys_eq!(t.borrower, a.borrower.key(), PrivateLoanError::NotBorrower);
    require!(t.status == STATUS_ACTIVE, PrivateLoanError::WrongStatus);
    a.check_accounts(&t)?;
    transfer(&a.token_program, &a.borrower_wsol, &a.loan_wsol, &a.borrower.to_account_info(), None, amount)?;
    t.collateral_locked = t.collateral_locked.checked_add(amount).ok_or(PrivateLoanError::MathOverflow)?;
    t.ledger_revision = t.ledger_revision.saturating_add(1);
    store(&info, &t)
}

/// From 24 hours after grace: the current lender takes collateral worth the payoff with no
/// bonus. The surplus returns to the borrower; any uncovered payoff is recorded.
pub fn claim_priced_recovery(ctx: Context<LenderClaim>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    a.check(&t)?;
    let clock = Clock::get()?;
    let terms = t.core_terms()?;
    require!(clock.unix_timestamp >= terms.priced_recovery_from(), PrivateLoanError::TooEarly);
    let payoff = t.payoff(clock.unix_timestamp)?;
    let price = loan_core::oracle::read_sol_usd_price(&a.price_update, &clock).map_err(core_error)?;
    let value = math::collateral_value_usdc(t.collateral_locked, price.price, price.conf, price.exponent).map_err(core_error)?;
    let split = acc::priced_recovery_split(payoff, t.collateral_locked, value).map_err(core_error)?;
    loan_signer!(a.anchor, nonce, seeds);
    transfer(&a.token_program, &a.loan_wsol, &a.lender_wsol, &a.anchor.to_account_info(), Some(&seeds), split.to_recipient)?;
    transfer(&a.token_program, &a.loan_wsol, &a.borrower_wsol, &a.anchor.to_account_info(), Some(&seeds), split.to_borrower)?;
    t.shortfall = split.shortfall;
    t.settle(STATUS_PRICED_RECOVERED, clock.unix_timestamp);
    store(&info, &t)
}

/// From seven days after grace: the current lender takes all remaining collateral without a
/// price. The agreed default remedy; it can lose the borrower's surplus.
pub fn claim_terminal(ctx: Context<LenderClaim>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    a.check(&t)?;
    let now = Clock::get()?.unix_timestamp;
    require!(now >= t.core_terms()?.terminal_claim_from(), PrivateLoanError::TooEarly);
    loan_signer!(a.anchor, nonce, seeds);
    transfer(&a.token_program, &a.loan_wsol, &a.lender_wsol, &a.anchor.to_account_info(), Some(&seeds), t.collateral_locked)?;
    t.settle(STATUS_TERMINAL_CLAIMED, now);
    store(&info, &t)
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateLoan<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(init, payer = lender, space = 8 + LoanAnchor::INIT_SPACE, seeds = [LOAN_SEED, lender.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub anchor: Account<'info, LoanAnchor>,
    /// Created empty now, so the settlement action later writes it without paying rent.
    #[account(init, payer = lender, space = 8 + crate::receipt::SettlementReceipt::INIT_SPACE, seeds = [crate::constants::RECEIPT_SEED, anchor.key().as_ref()], bump)]
    pub receipt: Account<'info, crate::receipt::SettlementReceipt>,
    /// CHECK: The room anchor this loan belongs to; only its key is stored.
    pub room: UncheckedAccount<'info>,
    pub usdc_mint: Account<'info, Mint>,
    pub wsol_mint: Account<'info, Mint>,
    /// Base token accounts the ER mirrors for this loan's custody. Without them
    /// the custody ATAs do not exist inside the rollup.
    #[account(init, payer = lender, associated_token::mint = usdc_mint, associated_token::authority = anchor)]
    pub usdc_ata: Account<'info, TokenAccount>,
    #[account(init, payer = lender, associated_token::mint = wsol_mint, associated_token::authority = anchor)]
    pub wsol_ata: Account<'info, TokenAccount>,
    /// CHECK: eATA [anchor, usdc] under eSPL, created here.
    #[account(mut, seeds = [anchor.key().as_ref(), usdc_mint.key().as_ref()], bump, seeds::program = ESPL_PROGRAM_ID)]
    pub usdc_eata: UncheckedAccount<'info>,
    /// CHECK: eATA [anchor, wsol] under eSPL, created here.
    #[account(mut, seeds = [anchor.key().as_ref(), wsol_mint.key().as_ref()], bump, seeds::program = ESPL_PROGRAM_ID)]
    pub wsol_eata: UncheckedAccount<'info>,
    /// CHECK: Delegation buffer, checked by the delegation program.
    #[account(mut)]
    pub usdc_buffer: UncheckedAccount<'info>,
    /// CHECK: Delegation record, checked by the delegation program.
    #[account(mut)]
    pub usdc_record: UncheckedAccount<'info>,
    /// CHECK: Delegation metadata, checked by the delegation program.
    #[account(mut)]
    pub usdc_metadata: UncheckedAccount<'info>,
    /// CHECK: Delegation buffer, checked by the delegation program.
    #[account(mut)]
    pub wsol_buffer: UncheckedAccount<'info>,
    /// CHECK: Delegation record, checked by the delegation program.
    #[account(mut)]
    pub wsol_record: UncheckedAccount<'info>,
    /// CHECK: Delegation metadata, checked by the delegation program.
    #[account(mut)]
    pub wsol_metadata: UncheckedAccount<'info>,
    /// CHECK: Fixed eSPL program id.
    #[account(address = ESPL_PROGRAM_ID)]
    pub espl_program: UncheckedAccount<'info>,
    /// CHECK: Fixed delegation program id.
    #[account(address = ephemeral_rollups_sdk::id())]
    pub delegation_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct DelegateLoan<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    /// CHECK: The loan anchor; ownership moves to the delegation program here.
    #[account(mut, del, seeds = [LOAN_SEED, lender.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub anchor: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ProposeTerms<'info> {
    pub lender: Signer<'info>,
    #[account(mut)]
    pub anchor: Account<'info, LoanAnchor>,
    pub room: Account<'info, RoomAnchor>,
    /// CHECK: ER-only `RoomState`; roles checked and the loan index advanced in the handler.
    #[account(mut, seeds = [ROOM_STATE_SEED, room.key().as_ref()], bump)]
    pub room_state: UncheckedAccount<'info>,
    /// CHECK: ER-only registry entry for the next room index; address checked in the handler.
    #[account(mut)]
    pub registry: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `registry`.
    #[account(mut)]
    pub registry_permission: UncheckedAccount<'info>,
    /// CHECK: ER-only `LoanTerms`, created here.
    #[account(mut, seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `terms`.
    #[account(mut)]
    pub terms_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[derive(Accounts)]
pub struct EditTerms<'info> {
    pub lender: Signer<'info>,
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(mut, seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct LenderMoves<'info> {
    pub lender: Signer<'info>,
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(mut, seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: Lender's USDC ATA as projected by the ER; checked in the handler.
    #[account(mut)]
    pub lender_usdc: UncheckedAccount<'info>,
    /// CHECK: Loan's USDC ATA as projected by the ER; checked in the handler.
    #[account(mut)]
    pub loan_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BorrowerMoves<'info> {
    pub borrower: Signer<'info>,
    /// Writable: on first acceptance it pays rent for the room deal record.
    #[account(mut)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(mut, seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: Borrower's USDC ATA; checked in the handler.
    #[account(mut)]
    pub borrower_usdc: UncheckedAccount<'info>,
    /// CHECK: Borrower's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub borrower_wsol: UncheckedAccount<'info>,
    /// CHECK: Loan's USDC ATA; checked in the handler.
    #[account(mut)]
    pub loan_usdc: UncheckedAccount<'info>,
    /// CHECK: Loan's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub loan_wsol: UncheckedAccount<'info>,
    /// CHECK: Current lender's USDC ATA (repayment destination); checked in `repay`.
    #[account(mut)]
    pub lender_usdc: UncheckedAccount<'info>,
    /// CHECK: Canonical Pyth receiver account; owner, feed, age, confidence, and exponent checked by loan-core.
    pub price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: ER-only deal record for this borrowing request (accept only); address checked in the handler.
    #[account(mut)]
    pub deal: Option<UncheckedAccount<'info>>,
    /// CHECK: Ephemeral permission for `deal` (accept only).
    #[account(mut)]
    pub deal_permission: Option<UncheckedAccount<'info>>,
    /// CHECK: Fixed ephemeral rent vault (accept only).
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: Option<UncheckedAccount<'info>>,
    pub magic_program: Option<Program<'info, MagicProgram>>,
    pub permission_program: Option<Program<'info, PermissionProgram>>,
    /// CHECK: The loan's terms permission (desk loans with auditors, accept only).
    #[account(mut)]
    pub terms_permission: Option<UncheckedAccount<'info>>,
    /// CHECK: The pinned `DeskPolicy` (desk loans, accept only); address checked in the handler.
    pub desk_policy: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct LenderClaim<'info> {
    pub lender: Signer<'info>,
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(mut, seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: Loan's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub loan_wsol: UncheckedAccount<'info>,
    /// CHECK: Current lender's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub lender_wsol: UncheckedAccount<'info>,
    /// CHECK: Borrower's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub borrower_wsol: UncheckedAccount<'info>,
    /// CHECK: Canonical Pyth receiver; read only by priced recovery.
    pub price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

impl LenderClaim<'_> {
    fn check(&self, t: &LoanTerms) -> Result<()> {
        require_keys_eq!(t.current_lender, self.lender.key(), PrivateLoanError::NotLender);
        require!(t.status == STATUS_ACTIVE, PrivateLoanError::WrongStatus);
        require_ata(&self.loan_wsol, &self.anchor.key(), &self.anchor.wsol_mint)?;
        require_ata(&self.lender_wsol, &t.current_lender, &self.anchor.wsol_mint)?;
        require_ata(&self.borrower_wsol, &t.borrower, &self.anchor.wsol_mint)
    }
}

impl<'info> BorrowerMoves<'info> {
    fn origination(&self) -> OriginationAccounts<'_, 'info> {
        OriginationAccounts {
            deal: self.deal.as_ref(),
            deal_permission: self.deal_permission.as_ref(),
            vault: self.vault.as_ref(),
            magic_program: self.magic_program.as_ref(),
            permission_program: self.permission_program.as_ref(),
            terms_permission: self.terms_permission.as_ref(),
            desk_policy: self.desk_policy.as_ref(),
        }
    }
}

impl BorrowerMoves<'_> {
    fn check_accounts(&self, t: &LoanTerms) -> Result<()> {
        let loan = self.anchor.key();
        require_ata(&self.borrower_usdc, &t.borrower, &self.anchor.usdc_mint)?;
        require_ata(&self.borrower_wsol, &t.borrower, &self.anchor.wsol_mint)?;
        require_ata(&self.loan_usdc, &loan, &self.anchor.usdc_mint)?;
        require_ata(&self.loan_wsol, &loan, &self.anchor.wsol_mint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms() -> LoanTerms {
        LoanTerms {
            version: 2, origin_lender: Pubkey::new_unique(), current_lender: Pubkey::new_unique(), borrower: Pubkey::new_unique(),
            room_index: 3, request_index: 1, principal: 100_000_000, interest_bps: 500, duration_seconds: 30 * 86_400,
            early_repayment: 1, min_interest_bps: 2_500, grace_seconds: 86_400, late_fee_bps: 100, annual_ceiling_bps: 10_000,
            collateral_required: 1_020_000_000, collateral_locked: 1_020_000_000, max_ltv_bps: 7_000, liquidation_ltv_bps: 8_000,
            revision: 1, funded_revision: 1, accepted_revision: 1, status: STATUS_ACTIVE, start_ts: 1_800_000_000,
            ledger: LedgerState::default(), ledger_revision: 0, shortfall: 0, settled_ts: 0, desk: Pubkey::default(), policy_version: 0,
            auditor_hash: [0; 32],
        }
    }

    #[test]
    fn terms_fit_the_record() {
        assert_eq!({ let mut v = Vec::new(); terms().serialize(&mut v).unwrap(); v.len() }, LoanTerms::LEN);
    }

    #[test]
    fn the_private_payoff_uses_the_shared_accounting() {
        let mut t = terms();
        t.ledger = acc::open(&t.core_terms().unwrap()).unwrap().into();
        assert_eq!(t.payoff(t.start_ts + 86_400).unwrap(), 101_250_000);
    }

    #[test]
    fn settling_zeroes_collateral_and_moves_the_ledger_revision() {
        let mut t = terms();
        t.settle(STATUS_REPAID, 5);
        assert_eq!((t.status, t.collateral_locked, t.settled_ts, t.ledger_revision), (STATUS_REPAID, 0, 5, 1));
    }
}
