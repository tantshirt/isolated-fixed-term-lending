//! Automated settlement (Epic 12.1; V2 Story 22.2).
//!
//! Each active loan gets one Hydra crank that calls `watch_loan`, which is permissionless,
//! signer-free, and harmless to repeat. V2 follows the shared accounting timeline:
//! - before grace ends, a public quote opens only when the conservative spot **and** EMA cross
//!   the liquidation line, or the spot alone is three points past it (emergency);
//! - from grace end, a quote opens regardless of LTV (overdue liquidation);
//! - priced recovery and the terminal claim are the lender's own instructions in `loan.rs`.
//! A quote's debt covers accrual until it expires; at execution the lender receives the exact
//! payoff and the liquidator's excess funding is returned with the payout, exactly once. Any
//! change to the ledger or collateral invalidates the open quote revision.
//!
//! Story 26.4: once a loan settles any other way (a repayment racing a quote), the next run
//! withdraws the open quote so funded tickets are refundable at once. Governance sets the quote
//! TTL in `QuoteParams`. Each crank's accounts are fixed when it is scheduled, so a crank bound
//! to an earlier lender makes no decision; `rebind_watch` schedules one for the current lender.

use crate::config::Config;
use crate::constants::{CONFIG_SEED, LIQ_POOL_SEED, LOAN_SEED, LOAN_TERMS_SEED, QUOTE_PARAMS_SEED, QUOTE_SEED, TEE_VALIDATOR};
use crate::error::{core_error, PrivateLoanError};
use crate::espl::{self, ESPL_PROGRAM_ID};
use crate::loan::{loan_signer, transfer, LoanAnchor, LoanTerms, STATUS_ACTIVE, STATUS_LIQUIDATED, STATUS_OVERDUE_LIQUIDATED};
use crate::room::{load, store};
use crate::schedule::{hydra_create, HYDRA_EPHEMERAL_ID};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{Mint, Token, TokenAccount};
use ephemeral_rollups_sdk::anchor::MagicProgram;
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;
use loan_core::accounting::{self as acc, Phase, PRICED_RECOVERY_DELAY, TERMINAL_CLAIM_DELAY};
use loan_core::math;

/// Default quote lifetime when governance has not written `QuoteParams`.
pub const QUOTE_TTL_SECONDS: i64 = 120;
/// Bounds governance may set: long enough to fund, short enough that accrual stays bounded.
pub const MIN_QUOTE_TTL_SECONDS: i64 = 30;
pub const MAX_QUOTE_TTL_SECONDS: i64 = 600;
pub const MAX_TICKETS: usize = 4;
/// About one check every 24 seconds at 400 ms slots. Eligibility always uses the clock, never this.
pub const WATCH_INTERVAL_SLOTS: u64 = 60;
const SECONDS_PER_RUN: u64 = 24;

pub const QUOTE_OPEN: u8 = 0;
pub const QUOTE_EXECUTED: u8 = 1;
pub const QUOTE_WITHDRAWN: u8 = 2;

pub const KIND_RISK: u8 = 0;
pub const KIND_OVERDUE: u8 = 1;

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

/// Base layer, written only by governance (the Squads vault); read-only inside the ER. Seeds
/// `["quote-params"]`.
#[account]
#[derive(InitSpace)]
pub struct QuoteParams {
    pub version: u8,
    pub quote_ttl_seconds: i64,
    pub bump: u8,
    pub reserved: [u8; 32],
}

/// The quote TTL from the crank's trailing `QuoteParams` account, or the default when it is
/// absent (cranks scheduled before Story 26.4) or not yet written.
fn quote_ttl(remaining: &[AccountInfo]) -> Result<i64> {
    let Some(info) = remaining.first() else { return Ok(QUOTE_TTL_SECONDS) };
    let (expected, _) = Pubkey::find_program_address(&[QUOTE_PARAMS_SEED], &crate::ID);
    require_keys_eq!(info.key(), expected, PrivateLoanError::InvalidRecord);
    if *info.owner != crate::ID || info.data_is_empty() {
        return Ok(QUOTE_TTL_SECONDS);
    }
    let p = QuoteParams::try_deserialize(&mut &info.try_borrow_data()?[..]).map_err(|_| error!(PrivateLoanError::InvalidRecord))?;
    Ok(p.quote_ttl_seconds.clamp(MIN_QUOTE_TTL_SECONDS, MAX_QUOTE_TTL_SECONDS))
}

/// Base layer. Governance rotates the quote parameters; operational keys cannot.
pub fn set_quote_params(ctx: Context<SetQuoteParams>, quote_ttl_seconds: i64) -> Result<()> {
    ctx.accounts.config.authorities.require_policy(&ctx.accounts.governance.key()).map_err(crate::error::governance_error)?;
    require!((MIN_QUOTE_TTL_SECONDS..=MAX_QUOTE_TTL_SECONDS).contains(&quote_ttl_seconds), PrivateLoanError::InvalidQuoteParams);
    let p = &mut ctx.accounts.params;
    p.version = 1;
    p.quote_ttl_seconds = quote_ttl_seconds;
    p.bump = ctx.bumps.params;
    p.reserved = [0; 32];
    Ok(())
}

/// Quote layout, edited in place. Public inside the ER: amounts disclose economics, but no
/// wallet or term beyond what a liquidator needs.
pub mod q {
    pub const VERSION: usize = 0; // 2
    pub const REVISION: usize = 1; // u32
    pub const DEBT: usize = 5; // u64: payoff at quote expiry, an upper bound
    pub const PAYOUT: usize = 13; // u64: wSOL for that debt
    pub const EXPIRES: usize = 21; // i64
    pub const STATE: usize = 29; // u8
    pub const COUNT: usize = 30; // u8
    pub const LEDGER_REV: usize = 31; // u32: the loan's ledger revision this quote priced
    pub const KIND: usize = 35; // u8: risk or overdue
    pub const TICKETS: usize = 36;
    /// liquidator 32 | paid_in u64 | revision u32 | min_payout u64 | payout u64 | excess u64 | state u8
    pub const T: usize = 32 + 8 + 4 + 8 + 8 + 8 + 1;
    pub const PAID_IN: usize = 32;
    pub const T_REVISION: usize = 40;
    pub const MIN_PAYOUT: usize = 44;
    pub const T_PAYOUT: usize = 52;
    pub const EXCESS: usize = 60;
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

/// Ownership alone does not identify an ER record. PDA constraints bind the quote to a typed
/// loan anchor; validate its raw layout before reading offsets.
fn validate_quote(info: &AccountInfo, allow_empty: bool) -> Result<()> {
    require_keys_eq!(*info.owner, crate::ID, PrivateLoanError::InvalidRecord);
    let d = info.try_borrow_data()?;
    require!(d.len() == q::LEN, PrivateLoanError::InvalidRecord);
    if allow_empty && d.iter().all(|b| *b == 0) {
        return Ok(());
    }
    require!(d[q::VERSION] == 2 && d[q::STATE] <= QUOTE_WITHDRAWN && d[q::KIND] <= KIND_OVERDUE, PrivateLoanError::InvalidRecord);
    require!((d[q::COUNT] as usize) <= MAX_TICKETS, PrivateLoanError::InvalidRecord);
    for i in 0..d[q::COUNT] as usize {
        require!(d[q::TICKETS + i * q::T + q::T - 1] <= TICKET_PAID, PrivateLoanError::InvalidRecord);
    }
    Ok(())
}

fn validate_pool_mints(anchor: &LoanAnchor, pool: &LiquidationPool) -> Result<()> {
    require_keys_eq!(anchor.usdc_mint, pool.usdc_mint, PrivateLoanError::WrongTokenAccount);
    require_keys_eq!(anchor.wsol_mint, pool.wsol_mint, PrivateLoanError::WrongTokenAccount);
    Ok(())
}

fn withdraw_open(info: &AccountInfo) -> Result<()> {
    if info.data_is_empty() {
        return Ok(());
    }
    let mut d = info.try_borrow_mut_data()?;
    if d[q::VERSION] == 2 && d[q::STATE] == QUOTE_OPEN {
        d[q::STATE] = QUOTE_WITHDRAWN;
    }
    Ok(())
}

/// How many watch runs cover a loan through its terminal claim window, with a day of slack.
pub fn watch_runs(duration: i64, grace: i64) -> u64 {
    let horizon = (duration + grace + PRICED_RECOVERY_DELAY.max(TERMINAL_CLAIM_DELAY) + 86_400).max(0) as u64;
    horizon / SECONDS_PER_RUN + 20
}

/// Whether a ticket may win at execution: it paid at least today's payoff, and the wSOL it now
/// receives is at least its accepted minimum scaled to the smaller payoff.
pub fn ticket_wins(paid_in: u64, min_payout: u64, quoted_debt: u64, payoff_now: u64, payout_now: u64) -> bool {
    paid_in >= payoff_now && (payout_now as u128) * (quoted_debt as u128) >= (min_payout as u128) * (payoff_now as u128)
}

// ---------------------------------------------------------------- base layer

/// The liquidation-pool admin from `Config`, once: the pool PDA, its token accounts, and
/// delegated eATAs.
pub fn init_liquidation_pool(ctx: Context<InitLiquidationPool>) -> Result<()> {
    ctx.accounts
        .config
        .authorities
        .require(governance::Role::LiquidationPoolAdmin, &ctx.accounts.admin.key())
        .map_err(crate::error::governance_error)?;
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

/// Anyone, once per active loan: schedules `watch_loan` with fixed accounts, lasting through
/// the terminal claim window.
pub fn schedule_watch(ctx: Context<ScheduleWatch>) -> Result<()> {
    let seed = ctx.accounts.anchor.key().to_bytes();
    schedule(ctx, seed, false)
}

/// Anyone, after the position changed hands: schedules a watch bound to the current lender's
/// USDC account. The earlier crank keeps running but makes no decision (`watch_loan`).
pub fn rebind_watch(ctx: Context<ScheduleWatch>) -> Result<()> {
    let t: LoanTerms = load(&ctx.accounts.terms.to_account_info())?;
    let anchor = ctx.accounts.anchor.key();
    let seed = solana_sha256_hasher::hashv(&[b"rebind", anchor.as_ref(), t.current_lender.as_ref()]).to_bytes();
    schedule(ctx, seed, true)
}

fn schedule(ctx: Context<ScheduleWatch>, crank_seed: [u8; 32], rebind: bool) -> Result<()> {
    let a = &ctx.accounts;
    validate_pool_mints(&a.anchor, &a.pool)?;
    // A wrong price account here would mean the loan is never liquidated. Reject it now.
    loan_core::oracle::check_sol_usd_account(&a.price_update).map_err(core_error)?;
    let t: LoanTerms = load(&a.terms.to_account_info())?;
    require!(t.status == STATUS_ACTIVE, PrivateLoanError::WrongStatus);
    // The original crank already follows the originating lender.
    if rebind {
        require_keys_neq!(t.current_lender, t.origin_lender, PrivateLoanError::NothingToRebind);
    }
    let anchor = &a.anchor;
    let usdc = anchor.usdc_mint;
    let wsol = anchor.wsol_mint;
    let (params, _) = Pubkey::find_program_address(&[QUOTE_PARAMS_SEED], &crate::ID);
    let metas: Vec<(Pubkey, bool)> = vec![
        (anchor.key(), true),
        (a.terms.key(), true),
        (a.quote.key(), true),
        (get_associated_token_address(&anchor.key(), &wsol), true),
        (get_associated_token_address(&t.current_lender, &usdc), true),
        (get_associated_token_address(&t.borrower, &wsol), true),
        (a.pool.key(), false),
        (get_associated_token_address(&a.pool.key(), &usdc), true),
        (get_associated_token_address(&a.pool.key(), &wsol), true),
        (a.price_update.key(), false),
        (anchor_spl::token::ID, false),
        // Trailing, read-only: the governance quote parameters (remaining account).
        (params, false),
    ];
    let remaining = watch_runs(t.duration_seconds, t.grace_seconds);
    loan_signer!(anchor, nonce, seeds);

    // Create the (empty, public) quote now, so `watch_loan` needs neither the rent vault nor
    // the magic program: the ER caps writable accounts per transaction.
    let quote_info = a.quote.to_account_info();
    if quote_info.data_is_empty() {
        let anchor_key = anchor.key();
        let qseeds: &[&[u8]] = &[QUOTE_SEED, anchor_key.as_ref(), &[ctx.bumps.quote]];
        EphemeralAccount::new(&anchor.to_account_info(), &quote_info, &a.vault.to_account_info())
            .with_signer_seeds(&[&seeds, qseeds])
            .create(q::LEN as u32)?;
    }
    hydra_create(
        &anchor.to_account_info(),
        &seeds,
        &a.crank,
        &a.vault,
        &a.magic_program,
        &a.hydra_program,
        crank_seed,
        anchor.key(),
        WATCH_INTERVAL_SLOTS,
        remaining,
        &metas,
        crate::instruction::WatchLoan::DISCRIMINATOR,
    )
}

pub fn watch_loan(ctx: Context<WatchLoan>) -> Result<()> {
    let a = &ctx.accounts;
    validate_pool_mints(&a.anchor, &a.pool)?;
    validate_quote(&a.quote.to_account_info(), true)?;
    let terms_info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&terms_info)?;
    if t.status != STATUS_ACTIVE {
        // Settled another way (a repayment racing the quote): tickets become refundable now.
        return withdraw_open(&a.quote.to_account_info());
    }
    let anchor = &a.anchor;
    require_keys_eq!(a.loan_wsol.key(), get_associated_token_address(&anchor.key(), &anchor.wsol_mint), PrivateLoanError::WrongTokenAccount);
    // A crank bound to an earlier lender makes no decision; the rebound crank does.
    if a.lender_usdc.key() != get_associated_token_address(&t.current_lender, &anchor.usdc_mint) {
        return Ok(());
    }
    let ttl = quote_ttl(ctx.remaining_accounts)?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let quote_info = a.quote.to_account_info();
    let terms = t.core_terms()?;
    let phase = acc::phase(&terms, now);
    let overdue = !matches!(phase, Phase::Active | Phase::Grace);

    // A stale or invalid price means no decision this round; the next tick retries.
    let Ok((spot, ema)) = loan_core::oracle::read_sol_usd_spot_and_ema(&a.price_update, &clock) else { return Ok(()) };
    let lamports = t.collateral_locked;
    let value = math::collateral_value_usdc(lamports, spot.price, spot.conf, spot.exponent).map_err(core_error)?;
    let payoff_now = t.payoff(now)?;
    if !overdue {
        let spot_ltv = math::current_ltv_bps(payoff_now, value).map_err(core_error)?;
        let ema_ltv = match ema {
            Some(e) => Some(acc::ltv_bps(payoff_now, lamports, e.price, e.conf, e.exponent).map_err(core_error)?),
            None => None,
        };
        if acc::liquidation_trigger(spot_ltv, ema_ltv, t.liquidation_ltv_bps).is_none() {
            return withdraw_open(&quote_info);
        }
    }
    let kind = if overdue { KIND_OVERDUE } else { KIND_RISK };
    // The quoted debt covers accrual until the quote expires; execution pays the exact payoff.
    let quoted_debt = t.payoff(now + ttl)?;
    let quoted_payout = acc::liquidation_split(quoted_debt, lamports, value).map_err(core_error)?.to_recipient;

    require_keys_eq!(*quote_info.owner, crate::ID, PrivateLoanError::InvalidRecord);
    let mut d = quote_info.try_borrow_mut_data()?;
    let stale = d[q::VERSION] == 0
        || d[q::STATE] != QUOTE_OPEN
        || rd_i64(&d, q::EXPIRES) < now
        || rd_u32(&d, q::LEDGER_REV) != t.ledger_revision
        || d[q::KIND] != kind;
    if stale {
        // New revision: earlier tickets become refundable.
        let rev = rd_u32(&d, q::REVISION).saturating_add(1);
        d[q::VERSION] = 2;
        d[q::REVISION..q::REVISION + 4].copy_from_slice(&rev.to_le_bytes());
        d[q::DEBT..q::DEBT + 8].copy_from_slice(&quoted_debt.to_le_bytes());
        d[q::PAYOUT..q::PAYOUT + 8].copy_from_slice(&quoted_payout.to_le_bytes());
        d[q::EXPIRES..q::EXPIRES + 8].copy_from_slice(&(now + ttl).to_le_bytes());
        d[q::STATE] = QUOTE_OPEN;
        d[q::LEDGER_REV..q::LEDGER_REV + 4].copy_from_slice(&t.ledger_revision.to_le_bytes());
        d[q::KIND] = kind;
        return Ok(());
    }

    let rev = rd_u32(&d, q::REVISION);
    let debt_on_quote = rd_u64(&d, q::DEBT);
    let split = acc::liquidation_split(payoff_now, lamports, value).map_err(core_error)?;
    let count = (d[q::COUNT] as usize).min(MAX_TICKETS);
    let winner = (0..count).find(|&i| {
        let o = q::TICKETS + i * q::T;
        d[o + q::T - 1] == TICKET_FUNDED
            && rd_u32(&d, o + q::T_REVISION) == rev
            && ticket_wins(rd_u64(&d, o + q::PAID_IN), rd_u64(&d, o + q::MIN_PAYOUT), debt_on_quote, payoff_now, split.to_recipient)
    });
    let Some(i) = winner else { return Ok(()) };
    let o = q::TICKETS + i * q::T;
    require_keys_eq!(a.lender_usdc.key(), get_associated_token_address(&t.current_lender, &anchor.usdc_mint), PrivateLoanError::WrongTokenAccount);
    require_keys_eq!(a.borrower_wsol.key(), get_associated_token_address(&t.borrower, &anchor.wsol_mint), PrivateLoanError::WrongTokenAccount);

    let ps = pool_seeds(&a.pool.bump);
    transfer(&a.token_program, &a.pool_usdc, &a.lender_usdc, &a.pool.to_account_info(), Some(&ps), payoff_now)?;
    loan_signer!(anchor, nonce, loan_seeds);
    transfer(&a.token_program, &a.loan_wsol, &a.pool_wsol, &anchor.to_account_info(), Some(&loan_seeds), split.to_recipient)?;
    transfer(&a.token_program, &a.loan_wsol, &a.borrower_wsol, &anchor.to_account_info(), Some(&loan_seeds), split.to_borrower)?;

    let excess = rd_u64(&d, o + q::PAID_IN) - payoff_now;
    d[o + q::T_PAYOUT..o + q::T_PAYOUT + 8].copy_from_slice(&split.to_recipient.to_le_bytes());
    d[o + q::EXCESS..o + q::EXCESS + 8].copy_from_slice(&excess.to_le_bytes());
    d[o + q::T - 1] = TICKET_WON;
    d[q::STATE] = QUOTE_EXECUTED;
    drop(d);
    let status = if kind == KIND_OVERDUE { STATUS_OVERDUE_LIQUIDATED } else { STATUS_LIQUIDATED };
    t.ledger.outstanding_principal = 0;
    t.ledger.interest_accrued = 0;
    t.settle(status, now);
    store(&terms_info, &t)
}

/// Liquidator: funds the current quote revision with its quoted debt, from a private balance,
/// and records the smallest payout they accept.
pub fn fund_quote(ctx: Context<FundQuote>, revision: u32) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.quote.to_account_info();
    validate_pool_mints(&a.anchor, &a.pool)?;
    validate_quote(&info, false)?;
    let (debt, payout) = {
        let d = info.try_borrow_data()?;
        require!(d[q::STATE] == QUOTE_OPEN, PrivateLoanError::WrongStatus);
        require!(rd_u32(&d, q::REVISION) == revision, PrivateLoanError::StaleRevision);
        require!(rd_i64(&d, q::EXPIRES) >= Clock::get()?.unix_timestamp, PrivateLoanError::RequestExpired);
        (rd_u64(&d, q::DEBT), rd_u64(&d, q::PAYOUT))
    };
    // Slots past COUNT are empty; refunded or paid slots can be reused.
    let slot = {
        let d = info.try_borrow_data()?;
        let count = d[q::COUNT] as usize;
        (0..MAX_TICKETS).find(|&i| i >= count || matches!(d[q::TICKETS + i * q::T + q::T - 1], TICKET_REFUNDED | TICKET_PAID))
    };
    let Some(i) = slot else { return err!(PrivateLoanError::RoomFull) };
    let me = a.liquidator.key();
    require_keys_eq!(a.liquidator_usdc.key(), get_associated_token_address(&me, &a.pool.usdc_mint), PrivateLoanError::WrongTokenAccount);
    transfer(&a.token_program, &a.liquidator_usdc, &a.pool_usdc, &a.liquidator.to_account_info(), None, debt)?;

    let mut d = info.try_borrow_mut_data()?;
    let o = q::TICKETS + i * q::T;
    d[o..o + 32].copy_from_slice(me.as_ref());
    d[o + q::PAID_IN..o + q::PAID_IN + 8].copy_from_slice(&debt.to_le_bytes());
    d[o + q::T_REVISION..o + q::T_REVISION + 4].copy_from_slice(&revision.to_le_bytes());
    d[o + q::MIN_PAYOUT..o + q::MIN_PAYOUT + 8].copy_from_slice(&payout.to_le_bytes());
    d[o + q::T_PAYOUT..o + q::T_PAYOUT + 8].copy_from_slice(&0u64.to_le_bytes());
    d[o + q::EXCESS..o + q::EXCESS + 8].copy_from_slice(&0u64.to_le_bytes());
    d[o + q::T - 1] = TICKET_FUNDED;
    d[q::COUNT] = d[q::COUNT].max((i + 1) as u8);
    Ok(())
}

/// Liquidator: collects the wSOL payout and any excess USDC if their ticket won, or a full
/// refund if it can no longer win. Each ticket settles once.
pub fn settle_ticket(ctx: Context<SettleTicket>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.quote.to_account_info();
    validate_pool_mints(&a.anchor, &a.pool)?;
    validate_quote(&info, false)?;
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
                let payout = rd_u64(&d, o + q::T_PAYOUT);
                let excess = rd_u64(&d, o + q::EXCESS);
                d[o + q::T - 1] = TICKET_PAID;
                drop(d);
                transfer(&a.token_program, &a.pool_wsol, &a.liquidator_wsol, &a.pool.to_account_info(), Some(&ps), payout)?;
                return transfer(&a.token_program, &a.pool_usdc, &a.liquidator_usdc, &a.pool.to_account_info(), Some(&ps), excess);
            }
            TICKET_FUNDED => {
                let still_in_play = state == QUOTE_OPEN && rd_u32(&d, o + q::T_REVISION) == rev && !expired;
                require!(!still_in_play, PrivateLoanError::TicketInPlay);
                let paid_in = rd_u64(&d, o + q::PAID_IN);
                d[o + q::T - 1] = TICKET_REFUNDED;
                drop(d);
                return transfer(&a.token_program, &a.pool_usdc, &a.liquidator_usdc, &a.pool.to_account_info(), Some(&ps), paid_in);
            }
            _ => settled = true,
        }
    }
    require!(!settled, PrivateLoanError::AlreadyAnswered);
    err!(PrivateLoanError::NotMember)
}

/// Anyone: refunds every ticket of `owner` that can no longer execute, to the owner's own USDC
/// account. Frees slots so a griefer who never collects cannot keep a quote full.
pub fn refund_ticket(ctx: Context<RefundTicket>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.quote.to_account_info();
    validate_pool_mints(&a.anchor, &a.pool)?;
    validate_quote(&info, false)?;
    let owner = a.owner.key();
    require_keys_eq!(a.owner_usdc.key(), get_associated_token_address(&owner, &a.pool.usdc_mint), PrivateLoanError::WrongTokenAccount);
    let now = Clock::get()?.unix_timestamp;
    let ps = pool_seeds(&a.pool.bump);

    let mut d = info.try_borrow_mut_data()?;
    let rev = rd_u32(&d, q::REVISION);
    let in_play_quote = d[q::STATE] == QUOTE_OPEN && rd_i64(&d, q::EXPIRES) >= now;
    let count = (d[q::COUNT] as usize).min(MAX_TICKETS);
    let mut total: u64 = 0;
    for i in 0..count {
        let o = q::TICKETS + i * q::T;
        if d[o..o + 32] != owner.to_bytes() || d[o + q::T - 1] != TICKET_FUNDED {
            continue;
        }
        if in_play_quote && rd_u32(&d, o + q::T_REVISION) == rev {
            continue;
        }
        total = total.checked_add(rd_u64(&d, o + q::PAID_IN)).ok_or(PrivateLoanError::MathOverflow)?;
        d[o + q::T - 1] = TICKET_REFUNDED;
    }
    drop(d);
    require!(total > 0, PrivateLoanError::NotMember);
    transfer(&a.token_program, &a.pool_usdc, &a.owner_usdc, &a.pool.to_account_info(), Some(&ps), total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ticket_that_paid_the_quote_wins_at_a_slightly_lower_payoff() {
        // Quoted 105 for 120s of accrual; 104.9 owed now. Payout shrinks proportionally.
        assert!(ticket_wins(105_000_000, 700_000_000, 105_000_000, 104_900_000, 699_333_334));
        assert!(!ticket_wins(105_000_000, 700_000_000, 105_000_000, 104_900_000, 699_000_000));
        // Paying less than today's payoff never wins.
        assert!(!ticket_wins(104_000_000, 1, 105_000_000, 104_900_000, 699_333_334));
    }

    #[test]
    fn the_watch_lasts_through_the_terminal_window() {
        let runs = watch_runs(30 * 86_400, 86_400);
        assert!(runs * SECONDS_PER_RUN >= (30 + 1 + 7) as u64 * 86_400);
    }

    #[test]
    fn quote_layout_fits() {
        assert_eq!(q::EXCESS + 8 + 1, q::T);
        assert_eq!(q::LEN, 36 + 4 * 69);
    }
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct InitLiquidationPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
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
pub struct SetQuoteParams<'info> {
    /// Must be `config.authorities.governance`; pays rent on the first write.
    #[account(mut)]
    pub governance: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init_if_needed, payer = governance, space = 8 + QuoteParams::INIT_SPACE, seeds = [QUOTE_PARAMS_SEED], bump)]
    pub params: Account<'info, QuoteParams>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ScheduleWatch<'info> {
    #[account(mut)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: Quote PDA for this loan, created here (empty) if missing.
    #[account(mut, seeds = [QUOTE_SEED, anchor.key().as_ref()], bump)]
    pub quote: UncheckedAccount<'info>,
    #[account(seeds = [LIQ_POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, LiquidationPool>,
    /// CHECK: Canonical Pyth receiver account named in the schedule; owner and feed checked here, age when it runs.
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
    /// CHECK: Public quote record, created empty by `schedule_watch`.
    #[account(mut, seeds = [QUOTE_SEED, anchor.key().as_ref()], bump)]
    pub quote: UncheckedAccount<'info>,
    /// CHECK: Loan's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub loan_wsol: UncheckedAccount<'info>,
    /// CHECK: Current lender's USDC ATA; checked in the handler.
    #[account(mut)]
    pub lender_usdc: UncheckedAccount<'info>,
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
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FundQuote<'info> {
    pub liquidator: Signer<'info>,
    #[account(seeds = [LOAN_SEED, anchor.creator.as_ref(), &anchor.nonce.to_le_bytes()], bump = anchor.bump)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: Canonical quote for the typed loan anchor; layout checked in handler.
    #[account(mut, seeds = [QUOTE_SEED, anchor.key().as_ref()], bump)]
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
    #[account(seeds = [LOAN_SEED, anchor.creator.as_ref(), &anchor.nonce.to_le_bytes()], bump = anchor.bump)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: Canonical quote for the typed loan anchor; layout checked in handler.
    #[account(mut, seeds = [QUOTE_SEED, anchor.key().as_ref()], bump)]
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

#[derive(Accounts)]
pub struct RefundTicket<'info> {
    /// CHECK: Ticket owner; refunds only go to this wallet's USDC ATA.
    pub owner: UncheckedAccount<'info>,
    #[account(seeds = [LOAN_SEED, anchor.creator.as_ref(), &anchor.nonce.to_le_bytes()], bump = anchor.bump)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: Canonical quote for the typed loan anchor; layout checked in handler.
    #[account(mut, seeds = [QUOTE_SEED, anchor.key().as_ref()], bump)]
    pub quote: UncheckedAccount<'info>,
    #[account(seeds = [LIQ_POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, LiquidationPool>,
    /// CHECK: Owner's USDC ATA; checked in the handler.
    #[account(mut)]
    pub owner_usdc: UncheckedAccount<'info>,
    /// CHECK: Pool USDC ATA.
    #[account(mut, address = get_associated_token_address(&pool.key(), &pool.usdc_mint))]
    pub pool_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
