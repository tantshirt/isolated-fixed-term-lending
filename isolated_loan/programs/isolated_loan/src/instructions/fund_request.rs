use crate::contexts::{FundRequest, RequestFunded};
use crate::constants::REQUEST_SEED;
use crate::error::LoanError;
use crate::oracle::read_sol_usd_price;
use crate::state::{math, OfferStatus, RequestStatus};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Transfer};

/// A lender funds an open request. The result is an ordinary filled `Offer`, so
/// repay, claim, liquidate and close work on it unchanged.
///
/// Rent: the lender pays for the offer and its wSOL vault and receives the request
/// vault's rent. Both vaults are token accounts of the same size, so each side ends
/// even once settlement returns the offer vault rent to the borrower.
pub fn handler(ctx: Context<FundRequest>, offer_id: u64) -> Result<()> {
    let request = &ctx.accounts.request;
    require!(
        ctx.accounts.lender.key() != request.borrower,
        LoanError::SameBorrowerAndLender
    );

    let clock = Clock::get()?;
    let oracle = read_sol_usd_price(&ctx.accounts.price_update.to_account_info(), &clock)?;

    let debt = math::debt(request.principal, request.interest_bps)?;
    let value = math::collateral_value_usdc(
        request.collateral_amount,
        oracle.price,
        oracle.conf,
        oracle.exponent,
    )?;
    let ltv = math::current_ltv_bps(debt, value)?;
    require!(ltv <= request.max_ltv_bps, LoanError::InsufficientCollateral);

    let request_key = request.key();
    let borrower = request.borrower;
    let request_id = request.request_id;
    let bump = request.bump;
    let principal = request.principal;
    let collateral = ctx.accounts.request_vault.amount;
    let expiry_ts = clock
        .unix_timestamp
        .checked_add(request.duration_seconds)
        .ok_or(LoanError::MathOverflow)?;

    let seeds = &[
        REQUEST_SEED,
        borrower.as_ref(),
        &request_id.to_le_bytes(),
        &[bump],
    ];
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
        principal,
    )?;

    let request = &ctx.accounts.request;
    let offer = &mut ctx.accounts.offer;
    offer.lender = ctx.accounts.lender.key();
    offer.borrower = borrower;
    offer.offer_id = offer_id;
    offer.usdc_mint = request.usdc_mint;
    offer.wsol_mint = request.wsol_mint;
    offer.principal = principal;
    offer.interest_bps = request.interest_bps;
    offer.duration_seconds = request.duration_seconds;
    offer.collateral_amount = collateral;
    offer.max_ltv_bps = request.max_ltv_bps;
    offer.liquidation_ltv_bps = request.liquidation_ltv_bps;
    offer.start_ts = clock.unix_timestamp;
    offer.expiry_ts = expiry_ts;
    offer.status = OfferStatus::Filled;
    offer.bump = ctx.bumps.offer;
    let offer_key = offer.key();
    let lender = offer.lender;

    let request = &mut ctx.accounts.request;
    request.status = RequestStatus::Funded;
    request.lender = lender;
    request.offer = offer_key;

    emit!(RequestFunded {
        request: request_key,
        offer: offer_key,
        lender,
        borrower,
        start_ts: clock.unix_timestamp,
        expiry_ts,
    });

    Ok(())
}
