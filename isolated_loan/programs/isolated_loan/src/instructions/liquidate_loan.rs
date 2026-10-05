use crate::contexts::{LiquidateLoan, LoanLiquidated};
use crate::constants::OFFER_SEED;
use crate::error::LoanError;
use crate::oracle::read_sol_usd_price;
use crate::state::{math, OfferStatus};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Transfer};

pub fn handler(ctx: Context<LiquidateLoan>) -> Result<()> {
    require!(
        ctx.accounts.caller.key() != ctx.accounts.offer.borrower,
        LoanError::BorrowerCannotLiquidate
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp < ctx.accounts.offer.expiry_ts,
        LoanError::LoanExpired
    );

    let oracle = read_sol_usd_price(&ctx.accounts.price_update.to_account_info(), &clock)?;
    let offer = &ctx.accounts.offer;
    let debt = offer.debt()?;
    let lamports = ctx.accounts.wsol_vault.amount;
    let value = math::collateral_value_usdc(lamports, oracle.price, oracle.conf, oracle.exponent)?;
    let ltv = math::current_ltv_bps(debt, value)?;
    require!(
        ltv >= offer.liquidation_ltv_bps,
        LoanError::LoanHealthy
    );

    let seize = math::seize_usdc(debt)?;
    let to_caller = math::wsol_to_caller(lamports, seize, value)?;
    let to_borrower = lamports
        .checked_sub(to_caller)
        .ok_or(LoanError::MathOverflow)?;

    let offer_key = offer.key();
    let offer_id = offer.offer_id;
    let lender = offer.lender;
    let bump = offer.bump;

    let seeds = &[
        OFFER_SEED,
        lender.as_ref(),
        &offer_id.to_le_bytes(),
        &[bump],
    ];
    let signer = &[&seeds[..]];

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.caller_usdc.to_account_info(),
                to: ctx.accounts.lender_usdc.to_account_info(),
                authority: ctx.accounts.caller.to_account_info(),
            },
        ),
        debt,
    )?;

    if to_caller > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.wsol_vault.to_account_info(),
                    to: ctx.accounts.caller_wsol.to_account_info(),
                    authority: ctx.accounts.offer.to_account_info(),
                },
                signer,
            ),
            to_caller,
        )?;
    }

    if to_borrower > 0 {
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
            to_borrower,
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

    ctx.accounts.offer.status = OfferStatus::Liquidated;

    emit!(LoanLiquidated {
        offer: offer_key,
        caller: ctx.accounts.caller.key(),
        debt,
        to_caller,
        to_borrower,
    });

    Ok(())
}
