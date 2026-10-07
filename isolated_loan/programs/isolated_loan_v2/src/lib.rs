//! ZenLo V2 public loan (Stories 21.1, 21.2 and 26.2).
//!
//! The upgrade authority and the governance key in `Config` are the Squads vault
//! (docs/governance.md). Governance writes only per-asset `CollateralConfig`s; it can never touch
//! a loan. All economics come from `loan_core::accounting`.
//!
//! Collateral is canonical wSOL (built-in SOL/USD constants) or a mint with a `CollateralConfig`
//! passed as the first remaining account of create, accept, fund, liquidation and priced recovery.

pub mod config;
pub mod contexts;
pub mod error;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Transfer};
use loan_core::accounting::{self as acc, Phase};

use config::*;
pub use contexts::*;
pub use error::*;
pub use state::*;

declare_id!("8hxagcQkw1Km6PWZgpA92qUnqvnFufC7tx2jvxf9Ko8m");

fn core<T>(r: loan_core::CoreResult<T>) -> Result<T> {
    r.map_err(core_error)
}

fn offer_seeds<'a>(offer: &'a OfferV2, id: &'a [u8; 8], bump: &'a [u8; 1]) -> [&'a [u8]; 4] {
    [OFFER_SEED, offer.origin_lender.as_ref(), id, bump]
}

/// Value the collateral at the conservative spot price of its own feed; the spot must pass every
/// V1 check. For wSOL this is exactly the SOL/USD read and the 9-decimal valuation.
fn spot_value(price_update: &AccountInfo, c: &Collateral, amount: u64, clock: &Clock) -> Result<u64> {
    let p = core(loan_core::oracle::read_price(price_update, clock, &c.feed_id))?;
    core(loan_core::math::collateral_value_usdc_decimals(amount, c.decimals, p.price, p.conf, p.exponent))
}

/// Origination checks for a new offer or request: the asset is wSOL or enabled, the mint's
/// decimals match, and the terms sit within the asset's caps.
fn check_new_collateral(mint: &Account<anchor_spl::token::Mint>, remaining: &[AccountInfo], args: &TermsArgs) -> Result<()> {
    let c = config::resolve(&mint.key(), remaining, true)?;
    require!(mint.decimals == c.decimals, LoanV2Error::InvalidWsolMint);
    c.check_caps(args.max_ltv_bps, args.liquidation_ltv_bps)
}

#[program]
pub mod isolated_loan_v2 {
    use super::*;

    pub fn create_offer(ctx: Context<CreateOffer>, offer_id: u64, args: TermsArgs, restricted_borrower: Pubkey) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        args.validate(now)?;
        check_new_collateral(&ctx.accounts.wsol_mint, ctx.remaining_accounts, &args)?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.lender_usdc.to_account_info(),
                    to: ctx.accounts.usdc_vault.to_account_info(),
                    authority: ctx.accounts.lender.to_account_info(),
                },
            ),
            args.principal,
        )?;
        let o = &mut ctx.accounts.offer;
        o.version = ACCOUNT_VERSION;
        o.origin_lender = ctx.accounts.lender.key();
        o.current_lender = ctx.accounts.lender.key();
        o.borrower = Pubkey::default();
        o.restricted_borrower = restricted_borrower;
        o.offer_id = offer_id;
        o.usdc_mint = ctx.accounts.usdc_mint.key();
        o.wsol_mint = ctx.accounts.wsol_mint.key();
        o.terms = args.terms();
        o.collateral_required = args.collateral_amount;
        o.collateral_locked = 0;
        o.max_ltv_bps = args.max_ltv_bps;
        o.liquidation_ltv_bps = args.liquidation_ltv_bps;
        o.status = StatusV2::Open;
        o.ledger = LedgerState::default();
        o.shortfall = 0;
        o.settled_ts = 0;
        o.bump = ctx.bumps.offer;
        o.reserved = [0; 64];
        emit!(OfferCreatedV2 { offer: o.key(), lender: o.origin_lender, principal: args.principal });
        Ok(())
    }

    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        let o = &ctx.accounts.offer;
        let (id, bump) = (o.offer_id.to_le_bytes(), [o.bump]);
        let seeds = offer_seeds(o, &id, &bump);
        let signer = &[&seeds[..]];
        let amount = ctx.accounts.usdc_vault.amount;
        if amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.usdc_vault.to_account_info(),
                        to: ctx.accounts.lender_usdc.to_account_info(),
                        authority: ctx.accounts.offer.to_account_info(),
                    },
                    signer,
                ),
                amount,
            )?;
        }
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.usdc_vault.to_account_info(),
                destination: ctx.accounts.lender.to_account_info(),
                authority: ctx.accounts.offer.to_account_info(),
            },
            signer,
        ))?;
        let o = &mut ctx.accounts.offer;
        o.status = StatusV2::Cancelled;
        o.settled_ts = Clock::get()?.unix_timestamp;
        emit!(SettledV2 { offer: o.key(), status: o.status, to_borrower: 0, to_recipient: 0, paid: 0, shortfall: 0 });
        Ok(())
    }

    /// Starts the loan. Origination LTV uses the maximum contractual exposure, not just principal
    /// plus interest, so a late fee can never make a fresh loan unhealthy by itself.
    pub fn accept_offer(ctx: Context<AcceptOffer>) -> Result<()> {
        let borrower = ctx.accounts.borrower.key();
        let o = &ctx.accounts.offer;
        require!(borrower != o.origin_lender && borrower != o.current_lender, LoanV2Error::SameBorrowerAndLender);
        require!(o.restricted_borrower == Pubkey::default() || o.restricted_borrower == borrower, LoanV2Error::RestrictedBorrower);
        let clock = Clock::get()?;
        let mut terms = o.terms;
        terms.start_ts = clock.unix_timestamp;
        let core_terms = terms.core()?;
        core(core_terms.validate())?;
        let exposure = core(core_terms.max_exposure())?;
        // Governance may have tightened or disabled the asset since the offer was created.
        let c = config::resolve(&o.wsol_mint, ctx.remaining_accounts, true)?;
        c.check_caps(o.max_ltv_bps, o.liquidation_ltv_bps)?;
        let value = spot_value(&ctx.accounts.price_update.to_account_info(), &c, o.collateral_required, &clock)?;
        let ltv = core(loan_core::math::current_ltv_bps(exposure, value))?;
        require!(ltv <= o.max_ltv_bps, LoanV2Error::InsufficientCollateral);

        let (id, bump) = (o.offer_id.to_le_bytes(), [o.bump]);
        let seeds = offer_seeds(o, &id, &bump);
        let signer = &[&seeds[..]];
        let principal = ctx.accounts.usdc_vault.amount;
        let collateral = o.collateral_required;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    to: ctx.accounts.borrower_usdc.to_account_info(),
                    authority: ctx.accounts.offer.to_account_info(),
                },
                signer,
            ),
            principal,
        )?;
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.usdc_vault.to_account_info(),
                destination: ctx.accounts.lender.to_account_info(),
                authority: ctx.accounts.offer.to_account_info(),
            },
            signer,
        ))?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.borrower_wsol.to_account_info(),
                    to: ctx.accounts.wsol_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            collateral,
        )?;
        let ledger = core(acc::open(&core_terms))?;
        let o = &mut ctx.accounts.offer;
        o.borrower = borrower;
        o.terms = terms;
        o.collateral_locked = collateral;
        o.ledger = ledger.into();
        o.status = StatusV2::Active;
        emit!(AcceptedV2 { offer: o.key(), borrower, start_ts: terms.start_ts, maturity_ts: core_terms.maturity(), grace_end_ts: core_terms.grace_end() });
        Ok(())
    }

    /// Pays up to `amount`: accrued interest, then late fee, then principal. A payment at or above
    /// the payoff closes the loan, takes only the payoff and returns all collateral. Open in every
    /// phase until a settlement executes.
    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        require!(amount > 0, LoanV2Error::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let o = &ctx.accounts.offer;
        let terms = o.terms.core()?;
        let (ledger, p) = core(acc::apply_payment(&terms, &o.ledger.into(), now, amount))?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.borrower_usdc.to_account_info(),
                    to: ctx.accounts.lender_usdc.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            p.used,
        )?;
        let offer_key = ctx.accounts.offer.key();
        if p.closed {
            let o = &ctx.accounts.offer;
            let (id, bump) = (o.offer_id.to_le_bytes(), [o.bump]);
            let seeds = offer_seeds(o, &id, &bump);
            let signer = &[&seeds[..]];
            let lamports = ctx.accounts.wsol_vault.amount;
            if lamports > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.wsol_vault.to_account_info(),
                            to: ctx.accounts.borrower_wsol.to_account_info(),
                            authority: ctx.accounts.offer.to_account_info(),
                        },
                        signer,
                    ),
                    lamports,
                )?;
            }
            token::close_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                CloseAccount {
                    account: ctx.accounts.wsol_vault.to_account_info(),
                    destination: ctx.accounts.borrower.to_account_info(),
                    authority: ctx.accounts.offer.to_account_info(),
                },
                signer,
            ))?;
            let o = &mut ctx.accounts.offer;
            o.collateral_locked = 0;
            o.status = StatusV2::Repaid;
            o.settled_ts = now;
            emit!(SettledV2 { offer: offer_key, status: StatusV2::Repaid, to_borrower: lamports, to_recipient: 0, paid: p.used, shortfall: 0 });
        }
        ctx.accounts.offer.ledger = ledger.into();
        emit!(PaymentV2 {
            offer: offer_key,
            used: p.used,
            interest: p.interest,
            late_fee: p.late_fee,
            principal: p.principal,
            adjustment: p.adjustment,
            closed: p.closed,
        });
        Ok(())
    }

    /// Adds wSOL to an active loan. No price is needed; health refreshes at the next valid price.
    pub fn add_collateral(ctx: Context<AddCollateral>, amount: u64) -> Result<()> {
        require!(amount > 0, LoanV2Error::ZeroAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.borrower_wsol.to_account_info(),
                    to: ctx.accounts.wsol_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            amount,
        )?;
        let o = &mut ctx.accounts.offer;
        o.collateral_locked = o.collateral_locked.checked_add(amount).ok_or(LoanV2Error::MathOverflow)?;
        emit!(CollateralAddedV2 { offer: o.key(), amount, collateral_locked: o.collateral_locked });
        Ok(())
    }

    /// Risk liquidation in the active term and grace: spot and EMA past the line, or spot alone
    /// three points further (emergency).
    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        let clock = Clock::get()?;
        let o = &ctx.accounts.offer;
        let terms = o.terms.core()?;
        require!(matches!(acc::phase(&terms, clock.unix_timestamp), Phase::Active | Phase::Grace), LoanV2Error::WrongStatus);
        let payoff = core(acc::payoff(&terms, &o.ledger.into(), clock.unix_timestamp))?;
        let lamports = ctx.accounts.wsol_vault.amount;
        // Servicing reads the asset's feed even if it was disabled for new loans.
        let c = config::resolve(&o.wsol_mint, ctx.remaining_accounts, false)?;
        let (spot, ema) = core(loan_core::oracle::read_spot_and_ema(&ctx.accounts.price_update.to_account_info(), &clock, &c.feed_id))?;
        let value_at = |p: &loan_core::oracle::OraclePrice| core(loan_core::math::collateral_value_usdc_decimals(lamports, c.decimals, p.price, p.conf, p.exponent));
        let spot_value = value_at(&spot)?;
        let spot_ltv = core(loan_core::math::current_ltv_bps(payoff, spot_value))?;
        let ema_ltv = match ema {
            Some(e) => Some(core(loan_core::math::current_ltv_bps(payoff, value_at(&e)?))?),
            None => None,
        };
        require!(acc::liquidation_trigger(spot_ltv, ema_ltv, o.liquidation_ltv_bps).is_some(), LoanV2Error::LoanHealthy);
        let split = core(acc::liquidation_split(payoff, lamports, spot_value))?;
        settle_by_caller(ctx, clock.unix_timestamp, payoff, split, StatusV2::Liquidated)
    }

    /// After grace, anyone may pay the payoff regardless of LTV and take collateral worth payoff
    /// plus 5%; the surplus returns to the borrower.
    pub fn liquidate_overdue(ctx: Context<Liquidate>) -> Result<()> {
        let clock = Clock::get()?;
        let o = &ctx.accounts.offer;
        let terms = o.terms.core()?;
        require!(clock.unix_timestamp >= terms.grace_end(), LoanV2Error::TooEarly);
        let payoff = core(acc::payoff(&terms, &o.ledger.into(), clock.unix_timestamp))?;
        let lamports = ctx.accounts.wsol_vault.amount;
        let c = config::resolve(&o.wsol_mint, ctx.remaining_accounts, false)?;
        let value = spot_value(&ctx.accounts.price_update.to_account_info(), &c, lamports, &clock)?;
        let split = core(acc::liquidation_split(payoff, lamports, value))?;
        settle_by_caller(ctx, clock.unix_timestamp, payoff, split, StatusV2::OverdueLiquidated)
    }

    /// From 24 hours after grace, the lender takes collateral worth the payoff with no bonus. The
    /// surplus returns to the borrower; any uncovered payoff is recorded as a shortfall.
    pub fn claim_priced_recovery(ctx: Context<LenderClaim>) -> Result<()> {
        let clock = Clock::get()?;
        let o = &ctx.accounts.offer;
        let terms = o.terms.core()?;
        require!(clock.unix_timestamp >= terms.priced_recovery_from(), LoanV2Error::TooEarly);
        let payoff = core(acc::payoff(&terms, &o.ledger.into(), clock.unix_timestamp))?;
        let lamports = ctx.accounts.wsol_vault.amount;
        let c = config::resolve(&o.wsol_mint, ctx.remaining_accounts, false)?;
        let value = spot_value(&ctx.accounts.price_update.to_account_info(), &c, lamports, &clock)?;
        let split = core(acc::priced_recovery_split(payoff, lamports, value))?;
        settle_by_lender(ctx, clock.unix_timestamp, split, StatusV2::PricedRecovered)
    }

    /// From seven days after grace, the lender may take all remaining collateral without a price.
    /// This is the agreed default remedy and can lose the borrower's surplus.
    pub fn claim_terminal(ctx: Context<LenderClaim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let terms = ctx.accounts.offer.terms.core()?;
        require!(now >= terms.terminal_claim_from(), LoanV2Error::TooEarly);
        let lamports = ctx.accounts.wsol_vault.amount;
        let split = acc::CollateralSplit { to_recipient: lamports, to_borrower: 0, shortfall: 0 };
        settle_by_lender(ctx, now, split, StatusV2::TerminalClaimed)
    }

    pub fn close_offer(_ctx: Context<CloseOffer>) -> Result<()> {
        Ok(())
    }

    pub fn create_request(ctx: Context<CreateRequest>, request_id: u64, args: TermsArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        args.validate(now)?;
        check_new_collateral(&ctx.accounts.wsol_mint, ctx.remaining_accounts, &args)?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.borrower_wsol.to_account_info(),
                    to: ctx.accounts.request_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            args.collateral_amount,
        )?;
        let r = &mut ctx.accounts.request;
        r.version = ACCOUNT_VERSION;
        r.borrower = ctx.accounts.borrower.key();
        r.request_id = request_id;
        r.usdc_mint = ctx.accounts.usdc_mint.key();
        r.wsol_mint = ctx.accounts.wsol_mint.key();
        r.terms = args.terms();
        r.collateral_amount = args.collateral_amount;
        r.max_ltv_bps = args.max_ltv_bps;
        r.liquidation_ltv_bps = args.liquidation_ltv_bps;
        r.created_ts = now;
        r.status = RequestStatusV2::Open;
        r.lender = Pubkey::default();
        r.offer = Pubkey::default();
        r.bump = ctx.bumps.request;
        r.reserved = [0; 32];
        Ok(())
    }

    pub fn cancel_request(ctx: Context<CancelRequest>) -> Result<()> {
        let r = &ctx.accounts.request;
        let (id, bump) = (r.request_id.to_le_bytes(), [r.bump]);
        let seeds: [&[u8]; 4] = [REQUEST_SEED, r.borrower.as_ref(), &id, &bump];
        let signer = &[&seeds[..]];
        let amount = ctx.accounts.request_vault.amount;
        if amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.request_vault.to_account_info(),
                        to: ctx.accounts.borrower_wsol.to_account_info(),
                        authority: ctx.accounts.request.to_account_info(),
                    },
                    signer,
                ),
                amount,
            )?;
        }
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.request_vault.to_account_info(),
                destination: ctx.accounts.borrower.to_account_info(),
                authority: ctx.accounts.request.to_account_info(),
            },
            signer,
        ))?;
        ctx.accounts.request.status = RequestStatusV2::Cancelled;
        Ok(())
    }

    /// A lender funds an open request; the result is an active `OfferV2`.
    pub fn fund_request(ctx: Context<FundRequest>, offer_id: u64) -> Result<()> {
        let lender = ctx.accounts.lender.key();
        let r = &ctx.accounts.request;
        require!(lender != r.borrower, LoanV2Error::SameBorrowerAndLender);
        let clock = Clock::get()?;
        let mut terms = r.terms;
        terms.start_ts = clock.unix_timestamp;
        let core_terms = terms.core()?;
        core(core_terms.validate())?;
        let exposure = core(core_terms.max_exposure())?;
        let collateral = ctx.accounts.request_vault.amount;
        let c = config::resolve(&r.wsol_mint, ctx.remaining_accounts, true)?;
        c.check_caps(r.max_ltv_bps, r.liquidation_ltv_bps)?;
        let value = spot_value(&ctx.accounts.price_update.to_account_info(), &c, collateral, &clock)?;
        let ltv = core(loan_core::math::current_ltv_bps(exposure, value))?;
        require!(ltv <= r.max_ltv_bps, LoanV2Error::InsufficientCollateral);

        let (id, bump) = (r.request_id.to_le_bytes(), [r.bump]);
        let seeds: [&[u8]; 4] = [REQUEST_SEED, r.borrower.as_ref(), &id, &bump];
        let signer = &[&seeds[..]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.request_vault.to_account_info(),
                    to: ctx.accounts.wsol_vault.to_account_info(),
                    authority: ctx.accounts.request.to_account_info(),
                },
                signer,
            ),
            collateral,
        )?;
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.request_vault.to_account_info(),
                destination: ctx.accounts.lender.to_account_info(),
                authority: ctx.accounts.request.to_account_info(),
            },
            signer,
        ))?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.lender_usdc.to_account_info(),
                    to: ctx.accounts.borrower_usdc.to_account_info(),
                    authority: ctx.accounts.lender.to_account_info(),
                },
            ),
            terms.principal,
        )?;
        let r = &ctx.accounts.request;
        let (borrower, usdc_mint, wsol_mint, max_ltv, liq_ltv) = (r.borrower, r.usdc_mint, r.wsol_mint, r.max_ltv_bps, r.liquidation_ltv_bps);
        let ledger = core(acc::open(&core_terms))?;
        let o = &mut ctx.accounts.offer;
        o.version = ACCOUNT_VERSION;
        o.origin_lender = lender;
        o.current_lender = lender;
        o.borrower = borrower;
        o.restricted_borrower = Pubkey::default();
        o.offer_id = offer_id;
        o.usdc_mint = usdc_mint;
        o.wsol_mint = wsol_mint;
        o.terms = terms;
        o.collateral_required = collateral;
        o.collateral_locked = collateral;
        o.max_ltv_bps = max_ltv;
        o.liquidation_ltv_bps = liq_ltv;
        o.status = StatusV2::Active;
        o.ledger = ledger.into();
        o.shortfall = 0;
        o.settled_ts = 0;
        o.bump = ctx.bumps.offer;
        o.reserved = [0; 64];
        let offer_key = o.key();
        let r = &mut ctx.accounts.request;
        r.status = RequestStatusV2::Funded;
        r.lender = lender;
        r.offer = offer_key;
        emit!(AcceptedV2 { offer: offer_key, borrower, start_ts: terms.start_ts, maturity_ts: core_terms.maturity(), grace_end_ts: core_terms.grace_end() });
        Ok(())
    }

    pub fn close_request(_ctx: Context<CloseRequest>) -> Result<()> {
        Ok(())
    }

    /// Once, by the upgrade authority (Story 26.2, same shape as `private_loan_v2`).
    pub fn init_config(ctx: Context<InitConfig>, authorities: governance::Authorities) -> Result<()> {
        config::init_config(ctx, authorities)
    }

    /// Governance only.
    pub fn rotate_authorities(ctx: Context<RotateAuthorities>, next: governance::Authorities) -> Result<()> {
        config::rotate_authorities(ctx, next)
    }

    /// Governance only: create or update one asset's `CollateralConfig`.
    pub fn set_collateral_config(ctx: Context<SetCollateralConfig>, args: CollateralConfigArgs) -> Result<()> {
        config::set_collateral_config(ctx, args)
    }
}

/// The caller pays the payoff to the current lender and the collateral is split.
fn settle_by_caller(ctx: Context<Liquidate>, now: i64, payoff: u64, split: acc::CollateralSplit, status: StatusV2) -> Result<()> {
    require!(ctx.accounts.caller.key() != ctx.accounts.offer.borrower, LoanV2Error::BorrowerCannotLiquidate);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.caller_usdc.to_account_info(),
                to: ctx.accounts.lender_usdc.to_account_info(),
                authority: ctx.accounts.caller.to_account_info(),
            },
        ),
        payoff,
    )?;
    let o = &ctx.accounts.offer;
    let (id, bump) = (o.offer_id.to_le_bytes(), [o.bump]);
    let seeds = offer_seeds(o, &id, &bump);
    let signer = &[&seeds[..]];
    let program = ctx.accounts.token_program.key();
    let offer_info = ctx.accounts.offer.to_account_info();
    pay_out(&program, &ctx.accounts.wsol_vault.to_account_info(), &ctx.accounts.caller_wsol.to_account_info(), &offer_info, signer, split.to_recipient)?;
    pay_out(&program, &ctx.accounts.wsol_vault.to_account_info(), &ctx.accounts.borrower_wsol.to_account_info(), &offer_info, signer, split.to_borrower)?;
    close_vault(&program, &ctx.accounts.wsol_vault.to_account_info(), &ctx.accounts.borrower.to_account_info(), &offer_info, signer)?;
    let o = &mut ctx.accounts.offer;
    finish(o, now, status, payoff, split)
}

/// The lender takes collateral directly; nothing is paid in USDC.
fn settle_by_lender(ctx: Context<LenderClaim>, now: i64, split: acc::CollateralSplit, status: StatusV2) -> Result<()> {
    let o = &ctx.accounts.offer;
    let (id, bump) = (o.offer_id.to_le_bytes(), [o.bump]);
    let seeds = offer_seeds(o, &id, &bump);
    let signer = &[&seeds[..]];
    let program = ctx.accounts.token_program.key();
    let offer_info = ctx.accounts.offer.to_account_info();
    pay_out(&program, &ctx.accounts.wsol_vault.to_account_info(), &ctx.accounts.lender_wsol.to_account_info(), &offer_info, signer, split.to_recipient)?;
    pay_out(&program, &ctx.accounts.wsol_vault.to_account_info(), &ctx.accounts.borrower_wsol.to_account_info(), &offer_info, signer, split.to_borrower)?;
    close_vault(&program, &ctx.accounts.wsol_vault.to_account_info(), &ctx.accounts.borrower.to_account_info(), &offer_info, signer)?;
    let o = &mut ctx.accounts.offer;
    finish(o, now, status, 0, split)
}

fn pay_out<'info>(program: &Pubkey, from: &AccountInfo<'info>, to: &AccountInfo<'info>, authority: &AccountInfo<'info>, signer: &[&[&[u8]]], amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new_with_signer(*program, Transfer { from: from.clone(), to: to.clone(), authority: authority.clone() }, signer),
        amount,
    )
}

fn close_vault<'info>(program: &Pubkey, vault: &AccountInfo<'info>, destination: &AccountInfo<'info>, authority: &AccountInfo<'info>, signer: &[&[&[u8]]]) -> Result<()> {
    token::close_account(CpiContext::new_with_signer(
        *program,
        CloseAccount { account: vault.clone(), destination: destination.clone(), authority: authority.clone() },
        signer,
    ))
}

fn finish(o: &mut Account<OfferV2>, now: i64, status: StatusV2, paid: u64, split: acc::CollateralSplit) -> Result<()> {
    o.collateral_locked = 0;
    o.shortfall = split.shortfall;
    o.status = status;
    o.settled_ts = now;
    emit!(SettledV2 { offer: o.key(), status, to_borrower: split.to_borrower, to_recipient: split.to_recipient, paid, shortfall: split.shortfall });
    Ok(())
}

#[event]
pub struct OfferCreatedV2 {
    pub offer: Pubkey,
    pub lender: Pubkey,
    pub principal: u64,
}

#[event]
pub struct AcceptedV2 {
    pub offer: Pubkey,
    pub borrower: Pubkey,
    pub start_ts: i64,
    pub maturity_ts: i64,
    pub grace_end_ts: i64,
}

#[event]
pub struct PaymentV2 {
    pub offer: Pubkey,
    pub used: u64,
    pub interest: u64,
    pub late_fee: u64,
    pub principal: u64,
    pub adjustment: u64,
    pub closed: bool,
}

#[event]
pub struct CollateralAddedV2 {
    pub offer: Pubkey,
    pub amount: u64,
    pub collateral_locked: u64,
}

#[event]
pub struct SettledV2 {
    pub offer: Pubkey,
    pub status: StatusV2,
    pub to_borrower: u64,
    pub to_recipient: u64,
    pub paid: u64,
    pub shortfall: u64,
}
