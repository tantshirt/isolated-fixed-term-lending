use crate::contexts::{CreateOffer, OfferCreated};
use crate::error::LoanError;
use crate::state::{math, OfferStatus};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

pub fn handler(
    ctx: Context<CreateOffer>,
    offer_id: u64,
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

    let offer = &mut ctx.accounts.offer;
    offer.lender = ctx.accounts.lender.key();
    offer.borrower = Pubkey::default();
    offer.offer_id = offer_id;
    offer.usdc_mint = ctx.accounts.usdc_mint.key();
    offer.wsol_mint = ctx.accounts.wsol_mint.key();
    offer.principal = principal;
    offer.interest_bps = interest_bps;
    offer.duration_seconds = duration_seconds;
    offer.collateral_amount = collateral_amount;
    offer.max_ltv_bps = max_ltv_bps;
    offer.liquidation_ltv_bps = liquidation_ltv_bps;
    offer.start_ts = 0;
    offer.expiry_ts = 0;
    offer.status = OfferStatus::Open;
    offer.bump = ctx.bumps.offer;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.lender_usdc.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.lender.to_account_info(),
            },
        ),
        principal,
    )?;

    emit!(OfferCreated {
        offer: offer.key(),
        lender: offer.lender,
        offer_id,
        principal,
    });

    Ok(())
}
