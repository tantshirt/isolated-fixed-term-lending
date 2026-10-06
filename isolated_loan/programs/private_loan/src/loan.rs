//! Private loans (Epic 10).
//!
//! `LoanAnchor` is delegated and owns the loan's USDC and wSOL eATAs, so each
//! loan's custody is separate. Exact terms, parties, approvals, and status live
//! in an ER-only `LoanTerms` record readable only by the lender and borrower;
//! committed accounts are plaintext on Solana (gate 8.7), so terms never are.
//! Money moves inside the TEE between the parties' private balances and the
//! loan's custody, using the same `loan-core` math and Pyth checks as the
//! public program.

use crate::constants::{LOAN_SEED, LOAN_TERMS_SEED, ROOM_DEAL_SEED, ROOM_STATE_SEED, TEE_VALIDATOR};
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
use loan_core::math;

pub const LOAN_SPONSOR_LAMPORTS: u64 = 10_000_000;

pub const STATUS_DRAFT: u8 = 0;
pub const STATUS_FUNDED: u8 = 1;
pub const STATUS_ACTIVE: u8 = 2;
pub const STATUS_REPAID: u8 = 3;
pub const STATUS_EXPIRED: u8 = 4;
pub const STATUS_CANCELLED: u8 = 5;

#[account]
#[derive(InitSpace)]
pub struct LoanAnchor {
    pub loan_id: [u8; 32],
    /// Room the loan was agreed in. An opaque id; it names no wallet.
    pub room: Pubkey,
    pub usdc_mint: Pubkey,
    pub wsol_mint: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct TermsArgs {
    pub borrower: Pubkey,
    pub principal: u64,
    pub interest_bps: u16,
    pub duration_seconds: i64,
    pub collateral_amount: u64,
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct LoanTerms {
    pub version: u8,
    pub lender: Pubkey,
    pub borrower: Pubkey,
    pub principal: u64,
    pub interest_bps: u16,
    pub duration_seconds: i64,
    pub collateral_amount: u64,
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
    /// Bumped on every financial edit; approvals bind to a revision.
    pub revision: u32,
    /// Revision the lender funded (its approval). 0 = none.
    pub funded_revision: u32,
    /// Revision the borrower accepted. 0 = none.
    pub accepted_revision: u32,
    pub status: u8,
    pub start_ts: i64,
    pub expiry_ts: i64,
}

impl LoanTerms {
    pub const LEN: usize = 1 + 32 + 32 + 8 + 2 + 8 + 8 + 2 + 2 + 4 + 4 + 4 + 1 + 8 + 8;

    pub fn debt(&self) -> Result<u64> {
        math::debt(self.principal, self.interest_bps).map_err(core_error)
    }

    fn apply(&mut self, a: &TermsArgs) -> Result<()> {
        require!(a.principal > 0 && a.collateral_amount > 0, PrivateLoanError::InvalidTerms);
        math::validate_terms(a.interest_bps, a.duration_seconds, a.max_ltv_bps, a.liquidation_ltv_bps)
            .map_err(core_error)?;
        self.borrower = a.borrower;
        self.principal = a.principal;
        self.interest_bps = a.interest_bps;
        self.duration_seconds = a.duration_seconds;
        self.collateral_amount = a.collateral_amount;
        self.max_ltv_bps = a.max_ltv_bps;
        self.liquidation_ltv_bps = a.liquidation_ltv_bps;
        Ok(())
    }
}

fn anchor_seeds(a: &LoanAnchor) -> [&[u8]; 3] {
    [LOAN_SEED, &a.loan_id, core::slice::from_ref(&a.bump)]
}

fn require_ata(account: &AccountInfo, owner: &Pubkey, mint: &Pubkey) -> Result<()> {
    require_keys_eq!(account.key(), get_associated_token_address(owner, mint), PrivateLoanError::WrongTokenAccount);
    Ok(())
}

fn transfer<'info>(
    token_program: &Program<'info, Token>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    seeds: Option<&[&[u8]]>,
    amount: u64,
) -> Result<()> {
    let accounts = Transfer { from: from.clone(), to: to.clone(), authority: authority.clone() };
    match seeds {
        Some(s) => token::transfer(CpiContext::new_with_signer(token_program.key(), accounts, &[s]), amount),
        None => token::transfer(CpiContext::new(token_program.key(), accounts), amount),
    }
}

/// Creates an ER-only record paid for and permission-signed by the loan anchor.
#[allow(clippy::too_many_arguments)]
fn create_loan_record<'info>(
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
    let seeds = anchor_seeds(anchor);
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

// ---------------------------------------------------------------- base layer

/// Creates the loan anchor, its two empty eATAs, and delegates the eATAs.
pub fn create_loan(ctx: Context<CreateLoan>, loan_id: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.usdc_mint.decimals == 6, PrivateLoanError::InvalidTerms);
    require!(a.wsol_mint.decimals == 9, PrivateLoanError::InvalidTerms);
    require!(
        loan_core::constants::mints_allowed(&a.usdc_mint.key(), &a.wsol_mint.key()),
        PrivateLoanError::MintNotAllowed
    );
    let anchor = &mut ctx.accounts.anchor;
    anchor.loan_id = loan_id;
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
pub fn delegate_loan(ctx: Context<DelegateLoan>, loan_id: [u8; 32]) -> Result<()> {
    ctx.accounts.delegate_anchor(
        &ctx.accounts.lender,
        &[LOAN_SEED, &loan_id],
        DelegateConfig { validator: Some(TEE_VALIDATOR), ..Default::default() },
    )?;
    Ok(())
}

// ------------------------------------------------------------- ephemeral rollup

pub fn propose_terms(ctx: Context<ProposeTerms>, args: TermsArgs) -> Result<()> {
    let a = &ctx.accounts;
    require_keys_eq!(a.anchor.room, a.room.key(), PrivateLoanError::WrongRoom);
    let room: RoomState = load(&a.room_state.to_account_info())?;
    let lender = a.lender.key();
    // The room owner may take either side; everyone else needs the matching role.
    let may = |who: &Pubkey, role: u8| {
        room.members.iter().any(|m| m.active && m.pubkey == *who && (m.role == role || m.pubkey == room.owner))
    };
    require!(may(&lender, ROLE_LENDER), PrivateLoanError::NotLender);
    require!(may(&args.borrower, ROLE_BORROWER), PrivateLoanError::NotBorrower);
    require_keys_neq!(lender, args.borrower, PrivateLoanError::NotBorrower);
    require!(a.terms.data_is_empty(), PrivateLoanError::RoomAlreadyInitialized);

    let mut terms = LoanTerms {
        version: 1,
        lender,
        borrower: args.borrower,
        principal: 0,
        interest_bps: 0,
        duration_seconds: 0,
        collateral_amount: 0,
        max_ltv_bps: 0,
        liquidation_ltv_bps: 0,
        revision: 1,
        funded_revision: 0,
        accepted_revision: 0,
        status: STATUS_DRAFT,
        start_ts: 0,
        expiry_ts: 0,
    };
    terms.apply(&args)?;

    let terms_info = a.terms.to_account_info();
    let anchor_key = a.anchor.key();
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
    require_keys_eq!(t.lender, ctx.accounts.lender.key(), PrivateLoanError::NotLender);
    require_keys_eq!(t.borrower, args.borrower, PrivateLoanError::NotBorrower);
    require!(t.status == STATUS_DRAFT, PrivateLoanError::WrongStatus);
    t.apply(&args)?;
    t.revision = t.revision.saturating_add(1);
    store(&info, &t)
}

/// Lender approves `revision` by locking the principal in the loan's custody.
pub fn fund_loan(ctx: Context<LenderMoves>, revision: u32) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    require_keys_eq!(t.lender, a.lender.key(), PrivateLoanError::NotLender);
    require!(t.status == STATUS_DRAFT, PrivateLoanError::WrongStatus);
    require!(t.revision == revision, PrivateLoanError::StaleRevision);
    require_ata(&a.lender_usdc, &t.lender, &a.anchor.usdc_mint)?;
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
    require_keys_eq!(t.lender, a.lender.key(), PrivateLoanError::NotLender);
    require!(t.status == STATUS_DRAFT || t.status == STATUS_FUNDED, PrivateLoanError::WrongStatus);
    if t.status == STATUS_FUNDED {
        require_ata(&a.lender_usdc, &t.lender, &a.anchor.usdc_mint)?;
        require_ata(&a.loan_usdc, &a.anchor.key(), &a.anchor.usdc_mint)?;
        let seeds = anchor_seeds(&a.anchor);
        transfer(&a.token_program, &a.loan_usdc, &a.lender_usdc, &a.anchor.to_account_info(), Some(&seeds), t.principal)?;
    }
    t.status = STATUS_CANCELLED;
    store(&info, &t)
}

/// Borrower approves the same `revision`: collateral in, principal out.
pub fn accept_loan(ctx: Context<BorrowerMoves>, revision: u32) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    require_keys_eq!(t.borrower, a.borrower.key(), PrivateLoanError::NotBorrower);
    require!(t.status == STATUS_FUNDED, PrivateLoanError::WrongStatus);
    require!(t.revision == revision && t.funded_revision == revision, PrivateLoanError::StaleRevision);
    a.check_accounts(&t)?;

    let clock = Clock::get()?;
    // One accepted offer per room: the first acceptance records itself, and any
    // competing offer fails. Unused funded offers stay cancellable by their lenders.
    let deal = a.deal.as_ref().ok_or(error!(PrivateLoanError::InvalidRecord))?;
    let loan_key = a.anchor.key();
    if deal.data_is_empty() {
        let room = a.anchor.room;
        let (_, bump) = Pubkey::find_program_address(&[ROOM_DEAL_SEED, room.as_ref()], &crate::ID);
        let bump = [bump];
        let missing = || error!(PrivateLoanError::InvalidRecord);
        create_loan_record(
            &a.anchor,
            &deal.to_account_info(),
            &a.deal_permission.as_ref().ok_or_else(missing)?.to_account_info(),
            &[ROOM_DEAL_SEED, room.as_ref(), &bump],
            32,
            vec![Member { flags: TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG, pubkey: t.borrower }],
            &a.vault.as_ref().ok_or_else(missing)?.to_account_info(),
            &a.magic_program.as_ref().ok_or_else(missing)?.to_account_info(),
            &a.permission_program.as_ref().ok_or_else(missing)?.to_account_info(),
        )?;
        deal.to_account_info().try_borrow_mut_data()?[..32].copy_from_slice(loan_key.as_ref());
    } else {
        let d = deal.to_account_info();
        require_keys_eq!(*d.owner, crate::ID, PrivateLoanError::InvalidRecord);
        let accepted = Pubkey::new_from_array(d.try_borrow_data()?[..32].try_into().unwrap());
        require_keys_eq!(accepted, loan_key, PrivateLoanError::CompetingOfferAccepted);
    }

    let price = loan_core::oracle::read_sol_usd_price(&a.price_update, &clock).map_err(core_error)?;
    let value = math::collateral_value_usdc(t.collateral_amount, price.price, price.conf, price.exponent).map_err(core_error)?;
    let ltv = math::current_ltv_bps(t.debt()?, value).map_err(core_error)?;
    require!(ltv <= t.max_ltv_bps, PrivateLoanError::InsufficientCollateral);

    transfer(&a.token_program, &a.borrower_wsol, &a.loan_wsol, &a.borrower.to_account_info(), None, t.collateral_amount)?;
    let seeds = anchor_seeds(&a.anchor);
    transfer(&a.token_program, &a.loan_usdc, &a.borrower_usdc, &a.anchor.to_account_info(), Some(&seeds), t.principal)?;

    t.status = STATUS_ACTIVE;
    t.accepted_revision = revision;
    t.start_ts = clock.unix_timestamp;
    t.expiry_ts = clock.unix_timestamp.checked_add(t.duration_seconds).ok_or(PrivateLoanError::MathOverflow)?;
    store(&info, &t)
}

/// Borrower pays the exact debt to the lender before the deadline and gets the collateral back.
pub fn repay_loan(ctx: Context<BorrowerMoves>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    require_keys_eq!(t.borrower, a.borrower.key(), PrivateLoanError::NotBorrower);
    require!(t.status == STATUS_ACTIVE, PrivateLoanError::WrongStatus);
    require!(Clock::get()?.unix_timestamp < t.expiry_ts, PrivateLoanError::LoanExpired);
    a.check_accounts(&t)?;
    require_ata(&a.lender_usdc, &t.lender, &a.anchor.usdc_mint)?;

    transfer(&a.token_program, &a.borrower_usdc, &a.lender_usdc, &a.borrower.to_account_info(), None, t.debt()?)?;
    let seeds = anchor_seeds(&a.anchor);
    transfer(&a.token_program, &a.loan_wsol, &a.borrower_wsol, &a.anchor.to_account_info(), Some(&seeds), t.collateral_amount)?;
    t.status = STATUS_REPAID;
    store(&info, &t)
}

/// Permissionless and signer-free: at or after the deadline, the collateral
/// goes to the lender's fixed wSOL account. Safe to retry after settlement.
pub fn claim_expired(ctx: Context<ClaimExpired>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    if t.status != STATUS_ACTIVE {
        return Ok(());
    }
    require!(Clock::get()?.unix_timestamp >= t.expiry_ts, PrivateLoanError::LoanNotExpired);
    require_ata(&a.loan_wsol, &a.anchor.key(), &a.anchor.wsol_mint)?;
    require_ata(&a.lender_wsol, &t.lender, &a.anchor.wsol_mint)?;
    let seeds = anchor_seeds(&a.anchor);
    transfer(&a.token_program, &a.loan_wsol, &a.lender_wsol, &a.anchor.to_account_info(), Some(&seeds), t.collateral_amount)?;
    t.status = STATUS_EXPIRED;
    store(&info, &t)
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
#[instruction(loan_id: [u8; 32])]
pub struct CreateLoan<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(init, payer = lender, space = 8 + LoanAnchor::INIT_SPACE, seeds = [LOAN_SEED, loan_id.as_ref()], bump)]
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
#[instruction(loan_id: [u8; 32])]
pub struct DelegateLoan<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    /// CHECK: The loan anchor; ownership moves to the delegation program here.
    #[account(mut, del, seeds = [LOAN_SEED, loan_id.as_ref()], bump)]
    pub anchor: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ProposeTerms<'info> {
    pub lender: Signer<'info>,
    #[account(mut)]
    pub anchor: Account<'info, LoanAnchor>,
    pub room: Account<'info, RoomAnchor>,
    /// CHECK: ER-only `RoomState`; roles checked in the handler.
    #[account(seeds = [ROOM_STATE_SEED, room.key().as_ref()], bump)]
    pub room_state: UncheckedAccount<'info>,
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
    /// CHECK: Lender's USDC ATA (repayment destination); checked in `repay_loan`.
    #[account(mut)]
    pub lender_usdc: UncheckedAccount<'info>,
    /// CHECK: Canonical Pyth receiver account; owner, feed, age, confidence, and exponent checked by loan-core.
    pub price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: ER-only room deal record (accept only); seeds checked here.
    #[account(mut, seeds = [ROOM_DEAL_SEED, anchor.room.as_ref()], bump)]
    pub deal: Option<UncheckedAccount<'info>>,
    /// CHECK: Ephemeral permission for `deal` (accept only).
    #[account(mut)]
    pub deal_permission: Option<UncheckedAccount<'info>>,
    /// CHECK: Fixed ephemeral rent vault (accept only).
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: Option<UncheckedAccount<'info>>,
    pub magic_program: Option<Program<'info, MagicProgram>>,
    pub permission_program: Option<Program<'info, PermissionProgram>>,
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

#[derive(Accounts)]
pub struct ClaimExpired<'info> {
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(mut, seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: Loan's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub loan_wsol: UncheckedAccount<'info>,
    /// CHECK: Lender's wSOL ATA, fixed by the terms; checked in the handler.
    #[account(mut)]
    pub lender_wsol: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
