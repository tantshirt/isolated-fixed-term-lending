//! Automated settlement (Epic 12.1).
//!
//! Each active loan gets one Hydra crank that calls `watch_loan`, which is
//! permissionless, signer-free, and harmless to repeat:
//! - at or after the deadline it sends the collateral to the lender;
//! - while the loan is past its liquidation line it keeps a short-lived public
//!   quote (debt to pay, collateral payout, expiry);
//! - once a liquidator has funded the current quote, it rechecks price,
//!   status, deadline, and the payout the liquidator accepted, then settles
//!   once using the public program's formula.
//! Liquidators fund quotes from their own private balance into a program pool
//! and never receive read access to the loan. They collect the payout, or a
//! refund when their quote did not execute, with `settle_ticket`.

use crate::constants::{LIQ_POOL_SEED, LOAN_SEED, LOAN_TERMS_SEED, QUOTE_SEED, TEE_VALIDATOR};
use crate::error::{core_error, PrivateLoanError};
use crate::espl::{self, ESPL_PROGRAM_ID};
use crate::loan::{LoanAnchor, LoanTerms, STATUS_ACTIVE, STATUS_EXPIRED};
use crate::room::{load, store};
use crate::schedule::{hydra_create, HYDRA_EPHEMERAL_ID};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::MagicProgram;
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;
use loan_core::math;

pub const STATUS_LIQUIDATED: u8 = 6;
pub const QUOTE_TTL_SECONDS: i64 = 120;
pub const MAX_TICKETS: usize = 4;
/// About one check every 24 seconds at 400 ms slots. Eligibility always uses the clock, never this.
pub const WATCH_INTERVAL_SLOTS: u64 = 60;

pub const QUOTE_OPEN: u8 = 0;
pub const QUOTE_EXECUTED: u8 = 1;
pub const QUOTE_WITHDRAWN: u8 = 2;

pub const TICKET_FUNDED: u8 = 0;
pub const TICKET_WON: u8 = 1;
pub const TICKET_REFUNDED: u8 = 2;
pub const TICKET_PAID: u8 = 3;

#[account]
#[derive(InitSpace)]
pub struct LiquidationPool {
    pub usdc_mint: Pubkey,
    pub wsol_mint: Pubkey,
    pub bump: u8,
}

/// Quote layout, edited in place. Public inside the ER: amounts disclose
/// economics, but no wallet or term beyond what a liquidator needs.
pub mod q {
    pub const VERSION: usize = 0;
    pub const REVISION: usize = 1; // u32
    pub const DEBT: usize = 5; // u64
    pub const PAYOUT: usize = 13; // u64
    pub const EXPIRES: usize = 21; // i64
    pub const STATE: usize = 29; // u8
    pub const COUNT: usize = 30; // u8
    pub const TICKETS: usize = 31;
    /// liquidator 32 | paid_in u64 | revision u32 | min_payout u64 | payout u64 | state u8
    pub const T: usize = 32 + 8 + 4 + 8 + 8 + 1;
    pub const LEN: usize = TICKETS + super::MAX_TICKETS * T;
}

fn rd_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn rd_u32(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
fn rd_i64(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

fn pool_seeds(bump: &u8) -> [&[u8]; 2] {
    [LIQ_POOL_SEED, core::slice::from_ref(bump)]
}

fn transfer<'info>(tp: &Program<'info, Token>, from: &AccountInfo<'info>, to: &AccountInfo<'info>, auth: &AccountInfo<'info>, seeds: Option<&[&[u8]]>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accounts = Transfer { from: from.clone(), to: to.clone(), authority: auth.clone() };
    match seeds {
        Some(s) => token::transfer(CpiContext::new_with_signer(tp.key(), accounts, &[s]), amount),
        None => token::transfer(CpiContext::new(tp.key(), accounts), amount),
    }
}

// ---------------------------------------------------------------- base layer

/// Admin, once: the pool PDA, its base token accounts, and delegated eATAs.
pub fn init_liquidation_pool(ctx: Context<InitLiquidationPool>) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    p.usdc_mint = ctx.accounts.usdc_mint.key();
    p.wsol_mint = ctx.accounts.wsol_mint.key();
    p.bump = ctx.bumps.pool;
    let a = &ctx.accounts;
    let pool_info = a.pool.to_account_info();
    for (eata, mint, buffer, record, metadata) in [
        (&a.usdc_eata, a.usdc_mint.to_account_info(), &a.usdc_buffer, &a.usdc_record, &a.usdc_metadata),
        (&a.wsol_eata, a.wsol_mint.to_account_info(), &a.wsol_buffer, &a.wsol_record, &a.wsol_metadata),
    ] {
        espl::initialize_ephemeral_ata(&a.espl_program, eata, &a.admin, &pool_info, &mint, &a.system_program)?;
        espl::delegate(&a.espl_program, &a.admin, eata, buffer, record, metadata, &a.delegation_program, &a.system_program, TEE_VALIDATOR)?;
    }
    Ok(())
}

// ------------------------------------------------------------- ephemeral rollup

/// Anyone, once per active loan: schedules `watch_loan` with fixed accounts.
pub fn schedule_watch(ctx: Context<ScheduleWatch>) -> Result<()> {
    let a = &ctx.accounts;
    let t: LoanTerms = load(&a.terms.to_account_info())?;
    require!(t.status == STATUS_ACTIVE, PrivateLoanError::WrongStatus);
    let anchor = &a.anchor;
    let usdc = anchor.usdc_mint;
    let wsol = anchor.wsol_mint;
    let metas: Vec<(Pubkey, bool)> = vec![
        (anchor.key(), true),
        (a.terms.key(), true),
        (a.quote.key(), true),
        (get_associated_token_address(&anchor.key(), &wsol), true),
        (get_associated_token_address(&t.lender, &usdc), true),
        (get_associated_token_address(&t.lender, &wsol), true),
        (get_associated_token_address(&t.borrower, &wsol), true),
        (a.pool.key(), false),
        (get_associated_token_address(&a.pool.key(), &usdc), true),
        (get_associated_token_address(&a.pool.key(), &wsol), true),
        (a.price_update.key(), false),
        (EPHEMERAL_VAULT_ID, true),
        (ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID, false),
        (anchor_spl::token::ID, false),
    ];
    let remaining = (t.duration_seconds as u64 / 24).saturating_add(20);
    let seeds = [LOAN_SEED, &anchor.loan_id[..], core::slice::from_ref(&anchor.bump)];
    hydra_create(
        &anchor.to_account_info(),
        &seeds,
        &a.crank,
        &a.vault,
        &a.magic_program,
        &a.hydra_program,
        anchor.loan_id,
        anchor.key(),
        WATCH_INTERVAL_SLOTS,
        remaining,
        &metas,
        crate::instruction::WatchLoan::DISCRIMINATOR,
    )
}

pub fn watch_loan(ctx: Context<WatchLoan>) -> Result<()> {
    let a = &ctx.accounts;
    let terms_info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&terms_info)?;
    if t.status != STATUS_ACTIVE {
        return Ok(());
    }
    let anchor = &a.anchor;
    let loan_seeds = [LOAN_SEED, &anchor.loan_id[..], core::slice::from_ref(&anchor.bump)];
    require_keys_eq!(a.lender_wsol.key(), get_associated_token_address(&t.lender, &anchor.wsol_mint), PrivateLoanError::WrongTokenAccount);
    require_keys_eq!(a.loan_wsol.key(), get_associated_token_address(&anchor.key(), &anchor.wsol_mint), PrivateLoanError::WrongTokenAccount);

    let clock = Clock::get()?;
    let quote_info = a.quote.to_account_info();

    // Expiry first: past the deadline the collateral goes to the lender.
    if clock.unix_timestamp >= t.expiry_ts {
        transfer(&a.token_program, &a.loan_wsol, &a.lender_wsol, &anchor.to_account_info(), Some(&loan_seeds), t.collateral_amount)?;
        t.status = STATUS_EXPIRED;
        store(&terms_info, &t)?;
        if !quote_info.data_is_empty() {
            let mut d = quote_info.try_borrow_mut_data()?;
            if d[q::STATE] == QUOTE_OPEN {
                d[q::STATE] = QUOTE_WITHDRAWN;
            }
        }
        return Ok(());
    }

    // A stale or invalid price means no decision this round; the next tick retries.
    let price = match loan_core::oracle::read_sol_usd_price(&a.price_update, &clock) {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };
    let debt = t.debt()?;
    let lamports = t.collateral_amount;
    let value = math::collateral_value_usdc(lamports, price.price, price.conf, price.exponent).map_err(core_error)?;
    let ltv = math::current_ltv_bps(debt, value).map_err(core_error)?;

    if ltv < t.liquidation_ltv_bps {
        if !quote_info.data_is_empty() {
            let mut d = quote_info.try_borrow_mut_data()?;
            if d[q::STATE] == QUOTE_OPEN {
                d[q::STATE] = QUOTE_WITHDRAWN;
            }
        }
        return Ok(());
    }

    let seize = math::seize_usdc(debt).map_err(core_error)?;
    let to_caller = math::wsol_to_caller(lamports, seize, value).map_err(core_error)?;

    if quote_info.data_is_empty() {
        let (_, bump) = Pubkey::find_program_address(&[QUOTE_SEED, anchor.key().as_ref()], &crate::ID);
        let anchor_key = anchor.key();
        let qseeds: &[&[u8]] = &[QUOTE_SEED, anchor_key.as_ref(), &[bump]];
        let anchor_info = anchor.to_account_info();
        EphemeralAccount::new(&anchor_info, &quote_info, &a.vault.to_account_info())
            .with_signer_seeds(&[&loan_seeds, qseeds])
            .create(q::LEN as u32)?;
    }

    let mut d = quote_info.try_borrow_mut_data()?;
    let expired = rd_i64(&d, q::EXPIRES) < clock.unix_timestamp;
    if d[q::VERSION] == 0 || d[q::STATE] != QUOTE_OPEN || expired {
        // New revision: earlier tickets become refundable.
        let rev = rd_u32(&d, q::REVISION).saturating_add(1);
        d[q::VERSION] = 1;
        d[q::REVISION..q::REVISION + 4].copy_from_slice(&rev.to_le_bytes());
        d[q::DEBT..q::DEBT + 8].copy_from_slice(&debt.to_le_bytes());
        d[q::PAYOUT..q::PAYOUT + 8].copy_from_slice(&to_caller.to_le_bytes());
        d[q::EXPIRES..q::EXPIRES + 8].copy_from_slice(&(clock.unix_timestamp + QUOTE_TTL_SECONDS).to_le_bytes());
        d[q::STATE] = QUOTE_OPEN;
        return Ok(());
    }

    // Execute the first ticket funded on this revision whose minimum payout still holds.
    let rev = rd_u32(&d, q::REVISION);
    let count = (d[q::COUNT] as usize).min(MAX_TICKETS);
    let winner = (0..count).find(|&i| {
        let o = q::TICKETS + i * q::T;
        d[o + q::T - 1] == TICKET_FUNDED && rd_u32(&d, o + 40) == rev && rd_u64(&d, o + 32) >= debt && to_caller >= rd_u64(&d, o + 44)
    });
    let Some(i) = winner else { return Ok(()) };
    let o = q::TICKETS + i * q::T;
    require_keys_eq!(a.lender_usdc.key(), get_associated_token_address(&t.lender, &anchor.usdc_mint), PrivateLoanError::WrongTokenAccount);
    require_keys_eq!(a.borrower_wsol.key(), get_associated_token_address(&t.borrower, &anchor.wsol_mint), PrivateLoanError::WrongTokenAccount);

    let pool_bump = a.pool.bump;
    let ps = pool_seeds(&pool_bump);
    transfer(&a.token_program, &a.pool_usdc, &a.lender_usdc, &a.pool.to_account_info(), Some(&ps), debt)?;
    transfer(&a.token_program, &a.loan_wsol, &a.pool_wsol, &anchor.to_account_info(), Some(&loan_seeds), to_caller)?;
    transfer(&a.token_program, &a.loan_wsol, &a.borrower_wsol, &anchor.to_account_info(), Some(&loan_seeds), lamports - to_caller)?;

    // Overpayment (paid_in above the debt) is returned with the payout.
    d[o + 52..o + 60].copy_from_slice(&to_caller.to_le_bytes());
    d[o + q::T - 1] = TICKET_WON;
    d[q::STATE] = QUOTE_EXECUTED;
    drop(d);
    t.status = STATUS_LIQUIDATED;
    store(&terms_info, &t)
}

/// Liquidator: funds the current quote revision with exactly the debt, from a
/// private balance, and records the smallest payout they accept.
pub fn fund_quote(ctx: Context<FundQuote>, revision: u32) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.quote.to_account_info();
    require_keys_eq!(*info.owner, crate::ID, PrivateLoanError::InvalidRecord);
    let (debt, payout) = {
        let d = info.try_borrow_data()?;
        require!(d[q::VERSION] == 1 && d[q::STATE] == QUOTE_OPEN, PrivateLoanError::WrongStatus);
        require!(rd_u32(&d, q::REVISION) == revision, PrivateLoanError::StaleRevision);
        require!(rd_i64(&d, q::EXPIRES) >= Clock::get()?.unix_timestamp, PrivateLoanError::RequestExpired);
        require!((d[q::COUNT] as usize) < MAX_TICKETS, PrivateLoanError::RoomFull);
        (rd_u64(&d, q::DEBT), rd_u64(&d, q::PAYOUT))
    };
    let me = a.liquidator.key();
    require_keys_eq!(a.liquidator_usdc.key(), get_associated_token_address(&me, &a.pool.usdc_mint), PrivateLoanError::WrongTokenAccount);
    transfer(&a.token_program, &a.liquidator_usdc, &a.pool_usdc, &a.liquidator.to_account_info(), None, debt)?;

    let mut d = info.try_borrow_mut_data()?;
    let i = d[q::COUNT] as usize;
    let o = q::TICKETS + i * q::T;
    d[o..o + 32].copy_from_slice(me.as_ref());
    d[o + 32..o + 40].copy_from_slice(&debt.to_le_bytes());
    d[o + 40..o + 44].copy_from_slice(&revision.to_le_bytes());
    d[o + 44..o + 52].copy_from_slice(&payout.to_le_bytes());
    d[o + 52..o + 60].copy_from_slice(&0u64.to_le_bytes());
    d[o + q::T - 1] = TICKET_FUNDED;
    d[q::COUNT] = (i + 1) as u8;
    Ok(())
}

/// Liquidator: collects the payout if their ticket won, or a refund if it
/// can no longer win. Each ticket settles once.
pub fn settle_ticket(ctx: Context<SettleTicket>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.quote.to_account_info();
    require_keys_eq!(*info.owner, crate::ID, PrivateLoanError::InvalidRecord);
    let me = a.liquidator.key();
    require_keys_eq!(a.liquidator_usdc.key(), get_associated_token_address(&me, &a.pool.usdc_mint), PrivateLoanError::WrongTokenAccount);
    require_keys_eq!(a.liquidator_wsol.key(), get_associated_token_address(&me, &a.pool.wsol_mint), PrivateLoanError::WrongTokenAccount);
    let now = Clock::get()?.unix_timestamp;
    let ps = pool_seeds(&a.pool.bump);

    let mut d = info.try_borrow_mut_data()?;
    let rev = rd_u32(&d, q::REVISION);
    let state = d[q::STATE];
    let expired = rd_i64(&d, q::EXPIRES) < now;
    let count = (d[q::COUNT] as usize).min(MAX_TICKETS);
    let mut settled = false;
    for i in 0..count {
        let o = q::TICKETS + i * q::T;
        if d[o..o + 32] != me.to_bytes() {
            continue;
        }
        match d[o + q::T - 1] {
            TICKET_WON => {
                let payout = rd_u64(&d, o + 52);
                d[o + q::T - 1] = TICKET_PAID;
                drop(d);
                transfer(&a.token_program, &a.pool_wsol, &a.liquidator_wsol, &a.pool.to_account_info(), Some(&ps), payout)?;
                return Ok(());
            }
            TICKET_FUNDED => {
                let still_in_play = state == QUOTE_OPEN && rd_u32(&d, o + 40) == rev && !expired;
                require!(!still_in_play, PrivateLoanError::TicketInPlay);
                let paid_in = rd_u64(&d, o + 32);
                d[o + q::T - 1] = TICKET_REFUNDED;
                drop(d);
                transfer(&a.token_program, &a.pool_usdc, &a.liquidator_usdc, &a.pool.to_account_info(), Some(&ps), paid_in)?;
                return Ok(());
            }
            _ => settled = true,
        }
    }
    require!(!settled, PrivateLoanError::AlreadyAnswered);
    err!(PrivateLoanError::NotMember)
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct InitLiquidationPool<'info> {
    #[account(mut, address = crate::ai::AI_ADMIN @ PrivateLoanError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + LiquidationPool::INIT_SPACE, seeds = [LIQ_POOL_SEED], bump)]
    pub pool: Account<'info, LiquidationPool>,
    pub usdc_mint: Account<'info, Mint>,
    pub wsol_mint: Account<'info, Mint>,
    #[account(init, payer = admin, associated_token::mint = usdc_mint, associated_token::authority = pool)]
    pub usdc_ata: Account<'info, TokenAccount>,
    #[account(init, payer = admin, associated_token::mint = wsol_mint, associated_token::authority = pool)]
    pub wsol_ata: Account<'info, TokenAccount>,
    /// CHECK: eATA [pool, usdc], created here.
    #[account(mut, seeds = [pool.key().as_ref(), usdc_mint.key().as_ref()], bump, seeds::program = ESPL_PROGRAM_ID)]
    pub usdc_eata: UncheckedAccount<'info>,
    /// CHECK: eATA [pool, wsol], created here.
    #[account(mut, seeds = [pool.key().as_ref(), wsol_mint.key().as_ref()], bump, seeds::program = ESPL_PROGRAM_ID)]
    pub wsol_eata: UncheckedAccount<'info>,
    /// CHECK: Delegation buffer.
    #[account(mut)]
    pub usdc_buffer: UncheckedAccount<'info>,
    /// CHECK: Delegation record.
    #[account(mut)]
    pub usdc_record: UncheckedAccount<'info>,
    /// CHECK: Delegation metadata.
    #[account(mut)]
    pub usdc_metadata: UncheckedAccount<'info>,
    /// CHECK: Delegation buffer.
    #[account(mut)]
    pub wsol_buffer: UncheckedAccount<'info>,
    /// CHECK: Delegation record.
    #[account(mut)]
    pub wsol_record: UncheckedAccount<'info>,
    /// CHECK: Delegation metadata.
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

#[derive(Accounts)]
pub struct ScheduleWatch<'info> {
    #[account(mut)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: Quote PDA for this loan (may not exist yet).
    #[account(seeds = [QUOTE_SEED, anchor.key().as_ref()], bump)]
    pub quote: UncheckedAccount<'info>,
    #[account(seeds = [LIQ_POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, LiquidationPool>,
    /// CHECK: Canonical Pyth receiver account named in the schedule; checked when it runs.
    pub price_update: UncheckedAccount<'info>,
    /// CHECK: Crank PDA, checked by Hydra.
    #[account(mut)]
    pub crank: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    /// CHECK: Fixed Hydra ephemeral program id.
    #[account(address = HYDRA_EPHEMERAL_ID)]
    pub hydra_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct WatchLoan<'info> {
    #[account(mut)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(mut, seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: ER-only quote, created here when the loan crosses its line.
    #[account(mut, seeds = [QUOTE_SEED, anchor.key().as_ref()], bump)]
    pub quote: UncheckedAccount<'info>,
    /// CHECK: Loan's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub loan_wsol: UncheckedAccount<'info>,
    /// CHECK: Lender's USDC ATA; checked in the handler.
    #[account(mut)]
    pub lender_usdc: UncheckedAccount<'info>,
    /// CHECK: Lender's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub lender_wsol: UncheckedAccount<'info>,
    /// CHECK: Borrower's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub borrower_wsol: UncheckedAccount<'info>,
    #[account(seeds = [LIQ_POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, LiquidationPool>,
    /// CHECK: Pool USDC ATA.
    #[account(mut, address = get_associated_token_address(&pool.key(), &pool.usdc_mint))]
    pub pool_usdc: UncheckedAccount<'info>,
    /// CHECK: Pool wSOL ATA.
    #[account(mut, address = get_associated_token_address(&pool.key(), &pool.wsol_mint))]
    pub pool_wsol: UncheckedAccount<'info>,
    /// CHECK: Canonical Pyth receiver; checked by loan-core.
    pub price_update: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault (quote creation).
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FundQuote<'info> {
    pub liquidator: Signer<'info>,
    /// CHECK: Public quote record; validated in the handler.
    #[account(mut)]
    pub quote: UncheckedAccount<'info>,
    #[account(seeds = [LIQ_POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, LiquidationPool>,
    /// CHECK: Liquidator's USDC ATA; checked in the handler.
    #[account(mut)]
    pub liquidator_usdc: UncheckedAccount<'info>,
    /// CHECK: Pool USDC ATA.
    #[account(mut, address = get_associated_token_address(&pool.key(), &pool.usdc_mint))]
    pub pool_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleTicket<'info> {
    pub liquidator: Signer<'info>,
    /// CHECK: Public quote record; validated in the handler.
    #[account(mut)]
    pub quote: UncheckedAccount<'info>,
    #[account(seeds = [LIQ_POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, LiquidationPool>,
    /// CHECK: Liquidator's USDC ATA; checked in the handler.
    #[account(mut)]
    pub liquidator_usdc: UncheckedAccount<'info>,
    /// CHECK: Liquidator's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub liquidator_wsol: UncheckedAccount<'info>,
    /// CHECK: Pool USDC ATA.
    #[account(mut, address = get_associated_token_address(&pool.key(), &pool.usdc_mint))]
    pub pool_usdc: UncheckedAccount<'info>,
    /// CHECK: Pool wSOL ATA.
    #[account(mut, address = get_associated_token_address(&pool.key(), &pool.wsol_mint))]
    pub pool_wsol: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
