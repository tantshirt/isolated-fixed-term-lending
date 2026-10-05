use crate::contexts::{CreateRequest, RequestCreated};
use crate::error::LoanError;
use crate::state::{math, RequestStatus};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

/// The borrower posts terms and locks the collateral now. No price is read here,
/// same as `create_offer`: the LTV cap is checked when a lender funds.
pub fn handler(
    ctx: Context<CreateRequest>,
    request_id: u64,
    principal: u64,
    interest_bps: u16,
    duration_seconds: i64,
    collateral_amount: u64,
    max_ltv_bps: u16,
    liquidation_ltv_bps: u16,
) -> Result<()> {
    require!(principal > 0, LoanError::InvalidTerms);
    require!(collateral_amount > 0, LoanError::InvalidTerms);
    math::validate_terms(
        interest_bps,
        duration_seconds,
        max_ltv_bps,
        liquidation_ltv_bps,
    )?;

    let request = &mut ctx.accounts.request;
    request.borrower = ctx.accounts.borrower.key();
    request.request_id = request_id;
    request.usdc_mint = ctx.accounts.usdc_mint.key();
    request.wsol_mint = ctx.accounts.wsol_mint.key();
    request.principal = principal;
    request.interest_bps = interest_bps;
    request.duration_seconds = duration_seconds;
    request.collateral_amount = collateral_amount;
    request.max_ltv_bps = max_ltv_bps;
    request.liquidation_ltv_bps = liquidation_ltv_bps;
    request.created_ts = Clock::get()?.unix_timestamp;
    request.status = RequestStatus::Open;
    request.lender = Pubkey::default();
    request.offer = Pubkey::default();
    request.bump = ctx.bumps.request;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.borrower_wsol.to_account_info(),
                to: ctx.accounts.request_vault.to_account_info(),
                authority: ctx.accounts.borrower.to_account_info(),
            },
        ),
        collateral_amount,
    )?;

    emit!(RequestCreated {
        request: request.key(),
        borrower: request.borrower,
        request_id,
        principal,
        collateral: collateral_amount,
    });

    Ok(())
}
