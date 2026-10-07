//! Automation mandates (Story 26.3, research.md § Automation mandates).
//!
//! A borrower pre-authorizes one bounded top-up or repay per loan and action. The mandate PDA
//! `["mandate", offer, action]` is the SPL delegate of the borrower's source token account for at
//! most `cumulative_cap` (amounts and fees together). Only `Config.authorities.keeper` executes,
//! and every bound is checked here: loan still active, expiry, trigger (conservative spot LTV of
//! the asset's own feed, or time before maturity), hysteresis, cumulative cap, fee per execution,
//! fee cap, and a repay clamped to the payoff. The allowance can only move into this loan's
//! collateral vault or to its current lender, plus the bounded fee to the keeper; it is never
//! liquidation capital. Revoking the mandate or the token delegate stops it at once.

use crate::config::{self, Config, CONFIG_SEED};
use crate::error::LoanV2Error;
use crate::state::{OfferV2, StatusV2};
use crate::{core, offer_seeds, pay_out, close_vault, spot_value, CollateralAddedV2, PaymentV2, SettledV2, WSOL_VAULT_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Approve, Revoke, Token, TokenAccount};
use loan_core::accounting as acc;
use loan_core::mandate::{self as m, Bounds, MandateError};

pub const MANDATE_SEED: &[u8] = b"mandate";
pub const MANDATE_VERSION: u8 = 1;

#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub version: u8,
    pub borrower: Pubkey,
    pub offer: Pubkey,
    /// 0 top-up (collateral into the vault), 1 repay (USDC to the current lender).
    pub action: u8,
    /// The borrower's token account this mandate is the delegate of.
    pub source: Pubkey,
    /// 0 health, 1 time.
    pub trigger: u8,
    pub trigger_ltv_bps: u16,
    pub lead_seconds: i64,
    pub amount_per_exec: u64,
    /// Everything drawn from the allowance: amounts plus fees.
    pub cumulative_cap: u64,
    pub used: u64,
    pub fee_per_exec: u64,
    pub fee_cap: u64,
    pub fees_paid: u64,
    pub expiry: i64,
    /// False after firing; a health trigger re-arms once LTV <= trigger - 200 bps.
    pub armed: bool,
    pub executions: u32,
    pub last_exec_ts: i64,
    pub bump: u8,
    pub reserved: [u8; 32],
}

impl Mandate {
    pub fn bounds(&self) -> Bounds {
        Bounds {
            action: self.action,
            trigger: self.trigger,
            trigger_ltv_bps: self.trigger_ltv_bps,
            lead_seconds: self.lead_seconds,
            amount_per_exec: self.amount_per_exec,
            cumulative_cap: self.cumulative_cap,
            fee_per_exec: self.fee_per_exec,
            fee_cap: self.fee_cap,
            expiry: self.expiry,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MandateArgs {
    pub action: u8,
    pub trigger: u8,
    pub trigger_ltv_bps: u16,
    pub lead_seconds: i64,
    pub amount_per_exec: u64,
    pub cumulative_cap: u64,
    pub fee_per_exec: u64,
    pub fee_cap: u64,
    pub expiry: i64,
}

impl MandateArgs {
    fn bounds(&self) -> Bounds {
        Bounds {
            action: self.action,
            trigger: self.trigger,
            trigger_ltv_bps: self.trigger_ltv_bps,
            lead_seconds: self.lead_seconds,
            amount_per_exec: self.amount_per_exec,
            cumulative_cap: self.cumulative_cap,
            fee_per_exec: self.fee_per_exec,
            fee_cap: self.fee_cap,
            expiry: self.expiry,
        }
    }
}

pub fn mandate_error(e: MandateError) -> Error {
    match e {
        MandateError::InvalidBounds => error!(LoanV2Error::MandateInvalid),
        MandateError::Expired => error!(LoanV2Error::MandateExpired),
        MandateError::NotTriggered => error!(LoanV2Error::MandateNotTriggered),
        MandateError::CapReached => error!(LoanV2Error::MandateCapReached),
        MandateError::FeeAboveCap => error!(LoanV2Error::MandateFeeAboveCap),
        MandateError::MathOverflow => error!(LoanV2Error::MathOverflow),
    }
}

/// The mint a mandate's source must hold: the collateral for a top-up, USDC for a repay.
fn source_mint(offer: &OfferV2, action: u8) -> Pubkey {
    if action == m::ACTION_TOP_UP {
        offer.wsol_mint
    } else {
        offer.usdc_mint
    }
}

/// Conservative spot LTV of the payoff against the vault, from the asset's own feed.
fn spot_ltv(offer: &OfferV2, price_update: &AccountInfo, remaining: &[AccountInfo], collateral: u64, clock: &Clock) -> Result<u16> {
    let terms = offer.terms.core()?;
    let payoff = core(acc::payoff(&terms, &offer.ledger.into(), clock.unix_timestamp))?;
    // Servicing: the asset's feed is read even if it was disabled for new loans.
    let c = config::resolve(&offer.wsol_mint, remaining, false)?;
    let value = spot_value(price_update, &c, collateral, clock)?;
    core(loan_core::math::current_ltv_bps(payoff, value))
}

pub fn create_mandate(ctx: Context<CreateMandate>, args: MandateArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let o = &ctx.accounts.offer;
    args.bounds().validate(now, o.liquidation_ltv_bps, o.terms.duration).map_err(mandate_error)?;
    let src = &ctx.accounts.source;
    require_keys_eq!(src.mint, source_mint(o, args.action), LoanV2Error::MandateWrongSource);
    // The whole allowance, fees included, is one SPL approval to this mandate's PDA.
    token::approve(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Approve {
                to: ctx.accounts.source.to_account_info(),
                delegate: ctx.accounts.mandate.to_account_info(),
                authority: ctx.accounts.borrower.to_account_info(),
            },
        ),
        args.cumulative_cap,
    )?;
    let (offer_key, source_key, borrower) = (ctx.accounts.offer.key(), ctx.accounts.source.key(), ctx.accounts.borrower.key());
    let md = &mut ctx.accounts.mandate;
    md.version = MANDATE_VERSION;
    md.borrower = borrower;
    md.offer = offer_key;
    md.action = args.action;
    md.source = source_key;
    md.trigger = args.trigger;
    md.trigger_ltv_bps = args.trigger_ltv_bps;
    md.lead_seconds = args.lead_seconds;
    md.amount_per_exec = args.amount_per_exec;
    md.cumulative_cap = args.cumulative_cap;
    md.used = 0;
    md.fee_per_exec = args.fee_per_exec;
    md.fee_cap = args.fee_cap;
    md.fees_paid = 0;
    md.expiry = args.expiry;
    md.armed = true;
    md.executions = 0;
    md.last_exec_ts = 0;
    md.bump = ctx.bumps.mandate;
    md.reserved = [0; 32];
    emit!(MandateCreated { mandate: md.key(), offer: offer_key, borrower, action: args.action, trigger: args.trigger, cumulative_cap: args.cumulative_cap, fee_cap: args.fee_cap, expiry: args.expiry });
    Ok(())
}

/// Keeper only. `fee` is what the keeper charges this time, within both fee bounds.
pub fn execute_mandate(ctx: Context<ExecuteMandate>, fee: u64) -> Result<()> {
    let a = &ctx.accounts;
    a.config.authorities.require(governance::Role::Keeper, &a.keeper.key()).map_err(config::governance_error)?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let (o, md) = (&a.offer, &a.mandate);
    let bounds = md.bounds();
    let terms = o.terms.core()?;

    let ltv = if md.trigger == m::TRIGGER_HEALTH {
        Some(spot_ltv(o, &a.price_update.to_account_info(), ctx.remaining_accounts, a.wsol_vault.amount, &clock)?)
    } else {
        None
    };
    m::fires(&bounds, md.armed, now, terms.maturity(), ltv).map_err(mandate_error)?;
    let payoff = if md.action == m::ACTION_REPAY { Some(core(acc::payoff(&terms, &o.ledger.into(), now))?) } else { None };
    let plan = m::plan(&bounds, md.used, md.fees_paid, fee, payoff).map_err(mandate_error)?;

    // The delegation must still be this mandate's, and large enough for this execution.
    let src = &a.source;
    require_keys_eq!(src.owner, md.borrower, LoanV2Error::MandateWrongSource);
    require_keys_eq!(src.mint, source_mint(o, md.action), LoanV2Error::MandateWrongSource);
    let total = plan.amount.checked_add(plan.fee).ok_or(LoanV2Error::MathOverflow)?;
    require!(src.delegate.contains(&md.key()) && src.delegated_amount >= total, LoanV2Error::MandateDelegateRevoked);

    let program = a.token_program.key();
    let offer_key = o.key();
    let action = [md.action];
    let bump = [md.bump];
    let mseeds: [&[u8]; 4] = [MANDATE_SEED, offer_key.as_ref(), &action, &bump];
    let msigner = &[&mseeds[..]];
    let src_info = a.source.to_account_info();
    let mandate_info = a.mandate.to_account_info();
    pay_out(&program, &src_info, &a.keeper_token.to_account_info(), &mandate_info, msigner, plan.fee)?;

    let moved = if md.action == m::ACTION_TOP_UP {
        pay_out(&program, &src_info, &a.wsol_vault.to_account_info(), &mandate_info, msigner, plan.amount)?;
        let o = &mut ctx.accounts.offer;
        o.collateral_locked = o.collateral_locked.checked_add(plan.amount).ok_or(LoanV2Error::MathOverflow)?;
        emit!(CollateralAddedV2 { offer: offer_key, amount: plan.amount, collateral_locked: o.collateral_locked });
        plan.amount
    } else {
        let (ledger, p, returned) = repay_from_mandate(&ctx, &terms, now, plan.amount, msigner)?;
        let o = &mut ctx.accounts.offer;
        o.ledger = ledger.into();
        if p.closed {
            o.collateral_locked = 0;
            o.status = StatusV2::Repaid;
            o.settled_ts = now;
            emit!(SettledV2 { offer: offer_key, status: StatusV2::Repaid, to_borrower: returned, to_recipient: 0, paid: p.used, shortfall: 0 });
        }
        emit!(PaymentV2 { offer: offer_key, used: p.used, interest: p.interest, late_fee: p.late_fee, principal: p.principal, adjustment: p.adjustment, closed: p.closed });
        p.used
    };

    let used = moved.checked_add(plan.fee).ok_or(LoanV2Error::MathOverflow)?;
    let md = &mut ctx.accounts.mandate;
    md.used = md.used.checked_add(used).ok_or(LoanV2Error::MathOverflow)?;
    md.fees_paid = md.fees_paid.checked_add(plan.fee).ok_or(LoanV2Error::MathOverflow)?;
    md.armed = false;
    md.executions = md.executions.saturating_add(1);
    md.last_exec_ts = now;
    emit!(MandateExecuted { mandate: md.key(), offer: offer_key, action: md.action, amount: moved, fee: plan.fee, used: md.used, fees_paid: md.fees_paid });
    Ok(())
}

/// The repay path of `repay`, paid by the mandate's delegation instead of the borrower's
/// signature: the same `apply_payment`, and on a closing payment the same collateral return and
/// vault close. Returns the new ledger, the payment and the collateral returned.
fn repay_from_mandate(ctx: &Context<ExecuteMandate>, terms: &acc::TermsV2, now: i64, amount: u64, msigner: &[&[&[u8]]]) -> Result<(acc::Ledger, acc::Payment, u64)> {
    let a = &ctx.accounts;
    let o = &a.offer;
    let lender_usdc = a.lender_usdc.as_ref().ok_or(LoanV2Error::UnauthorizedLender)?;
    require_keys_eq!(lender_usdc.owner, o.current_lender, LoanV2Error::UnauthorizedLender);
    require_keys_eq!(lender_usdc.mint, o.usdc_mint, LoanV2Error::UnauthorizedLender);
    let (ledger, p) = core(acc::apply_payment(terms, &o.ledger.into(), now, amount))?;
    let program = a.token_program.key();
    pay_out(&program, &a.source.to_account_info(), &lender_usdc.to_account_info(), &a.mandate.to_account_info(), msigner, p.used)?;
    let mut returned = 0;
    if p.closed {
        let borrower_wsol = a.borrower_wsol.as_ref().ok_or(LoanV2Error::UnauthorizedBorrower)?;
        let borrower = a.borrower.as_ref().ok_or(LoanV2Error::UnauthorizedBorrower)?;
        require_keys_eq!(borrower.key(), o.borrower, LoanV2Error::UnauthorizedBorrower);
        require_keys_eq!(borrower_wsol.owner, o.borrower, LoanV2Error::UnauthorizedBorrower);
        require_keys_eq!(borrower_wsol.mint, o.wsol_mint, LoanV2Error::UnauthorizedBorrower);
        let (id, bump) = (o.offer_id.to_le_bytes(), [o.bump]);
        let seeds = offer_seeds(o, &id, &bump);
        let signer = &[&seeds[..]];
        let offer_info = o.to_account_info();
        returned = a.wsol_vault.amount;
        pay_out(&program, &a.wsol_vault.to_account_info(), &borrower_wsol.to_account_info(), &offer_info, signer, returned)?;
        close_vault(&program, &a.wsol_vault.to_account_info(), &borrower.to_account_info(), &offer_info, signer)?;
    }
    Ok((ledger, p, returned))
}

/// Keeper or borrower: a fired health trigger re-arms once the conservative spot LTV is at or
/// below `trigger_ltv_bps - 200`, read from a valid price.
pub fn rearm_mandate(ctx: Context<RearmMandate>) -> Result<()> {
    let a = &ctx.accounts;
    let signer = a.signer.key();
    let is_keeper = a.config.authorities.require(governance::Role::Keeper, &signer).is_ok();
    require!(is_keeper || signer == a.mandate.borrower, LoanV2Error::WrongAuthority);
    let clock = Clock::get()?;
    let md = &a.mandate;
    require!(clock.unix_timestamp < md.expiry, LoanV2Error::MandateExpired);
    // A time trigger never re-arms, so no price is read for it.
    require!(md.trigger == m::TRIGGER_HEALTH && !md.armed, LoanV2Error::MandateNotTriggered);
    let ltv = spot_ltv(&a.offer, &a.price_update.to_account_info(), ctx.remaining_accounts, a.wsol_vault.amount, &clock)?;
    require!(m::may_rearm(&md.bounds(), md.armed, ltv), LoanV2Error::MandateNotTriggered);
    let md = &mut ctx.accounts.mandate;
    md.armed = true;
    emit!(MandateRearmed { mandate: md.key(), ltv_bps: ltv });
    Ok(())
}

/// Borrower: closes the mandate and revokes the token delegate if it is still this mandate's.
/// Works in any loan status, so a settled loan's mandate can always be cleaned up.
pub fn revoke_mandate(ctx: Context<RevokeMandate>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.source.to_account_info();
    let ours = *info.owner == token::ID && !info.data_is_empty() && {
        let parsed = TokenAccount::try_deserialize(&mut &info.try_borrow_data()?[..]);
        matches!(parsed, Ok(src) if src.owner == a.borrower.key() && src.delegate.contains(&a.mandate.key()))
    };
    if ours {
        token::revoke(CpiContext::new(a.token_program.key(), Revoke { source: info.clone(), authority: a.borrower.to_account_info() }))?;
    }
    emit!(MandateRevoked { mandate: a.mandate.key(), offer: a.mandate.offer });
    Ok(())
}

#[derive(Accounts)]
#[instruction(args: MandateArgs)]
pub struct CreateMandate<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(
        has_one = borrower @ LoanV2Error::UnauthorizedBorrower,
        constraint = offer.status == StatusV2::Active @ LoanV2Error::WrongStatus,
    )]
    pub offer: Box<Account<'info, OfferV2>>,
    #[account(
        init,
        payer = borrower,
        space = 8 + Mandate::INIT_SPACE,
        seeds = [MANDATE_SEED, offer.key().as_ref(), &[args.action]],
        bump,
    )]
    pub mandate: Box<Account<'info, Mandate>>,
    /// The borrower's token account the allowance comes from; its mint is checked in the handler.
    #[account(mut, token::authority = borrower)]
    pub source: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteMandate<'info> {
    /// Must be `config.authorities.keeper`.
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, constraint = offer.status == StatusV2::Active @ LoanV2Error::WrongStatus)]
    pub offer: Box<Account<'info, OfferV2>>,
    #[account(
        mut,
        has_one = offer @ LoanV2Error::MandateWrongSource,
        seeds = [MANDATE_SEED, offer.key().as_ref(), &[mandate.action]],
        bump = mandate.bump,
    )]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, address = mandate.source @ LoanV2Error::MandateWrongSource)]
    pub source: Box<Account<'info, TokenAccount>>,
    /// Receives the fee, in the source's mint.
    #[account(mut, token::mint = source.mint, token::authority = keeper)]
    pub keeper_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [WSOL_VAULT_SEED, offer.key().as_ref()], bump, token::mint = offer.wsol_mint, token::authority = offer)]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: Pyth price update; read only by a health trigger. Owner, feed, age and band are
    /// checked in loan-core.
    pub price_update: UncheckedAccount<'info>,
    /// Repay only: the current lender's USDC account; checked in the handler.
    #[account(mut)]
    pub lender_usdc: Option<Box<Account<'info, TokenAccount>>>,
    /// Repay only: receives the collateral vault's rent if this payment closes the loan.
    #[account(mut)]
    pub borrower: Option<SystemAccount<'info>>,
    /// Repay only: receives the collateral if this payment closes the loan.
    #[account(mut)]
    pub borrower_wsol: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RearmMandate<'info> {
    /// The keeper or the borrower.
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(constraint = offer.status == StatusV2::Active @ LoanV2Error::WrongStatus)]
    pub offer: Box<Account<'info, OfferV2>>,
    #[account(mut, has_one = offer @ LoanV2Error::MandateWrongSource)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(seeds = [WSOL_VAULT_SEED, offer.key().as_ref()], bump, token::mint = offer.wsol_mint, token::authority = offer)]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: Pyth price update; checked in loan-core.
    pub price_update: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RevokeMandate<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut, has_one = borrower @ LoanV2Error::UnauthorizedBorrower, close = borrower)]
    pub mandate: Box<Account<'info, Mandate>>,
    /// CHECK: The mandate's source token account. Revoked only if it still delegates to this
    /// mandate and the borrower still owns it; it may already be closed.
    #[account(mut, address = mandate.source @ LoanV2Error::MandateWrongSource)]
    pub source: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct MandateCreated {
    pub mandate: Pubkey,
    pub offer: Pubkey,
    pub borrower: Pubkey,
    pub action: u8,
    pub trigger: u8,
    pub cumulative_cap: u64,
    pub fee_cap: u64,
    pub expiry: i64,
}

#[event]
pub struct MandateExecuted {
    pub mandate: Pubkey,
    pub offer: Pubkey,
    pub action: u8,
    pub amount: u64,
    pub fee: u64,
    pub used: u64,
    pub fees_paid: u64,
}

#[event]
pub struct MandateRearmed {
    pub mandate: Pubkey,
    pub ltv_bps: u16,
}

#[event]
pub struct MandateRevoked {
    pub mandate: Pubkey,
    pub offer: Pubkey,
}
