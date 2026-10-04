use crate::contexts::{AcceptOffer, OfferAccepted};
use crate::constants::OFFER_SEED;
use crate::error::LoanError;
use crate::oracle::read_sol_usd_price;
use crate::state::{math, OfferStatus};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Transfer};

pub fn handler(ctx: Context<AcceptOffer>) -> Result<()> {
    require!(
        ctx.accounts.borrower.key() != ctx.accounts.offer.lender,
        LoanError::SameBorrowerAndLender
    );

    let clock = Clock::get()?;
    let oracle = read_sol_usd_price(&ctx.accounts.price_update.to_account_info(), &clock)?;

    let offer = &ctx.accounts.offer;
    let debt = offer.debt()?;
    let value = math::collateral_value_usdc(
        offer.collateral_amount,
        oracle.price,
        oracle.conf,
        oracle.exponent,
    )?;
    let ltv = math::current_ltv_bps(debt, value)?;
    require!(ltv <= offer.max_ltv_bps, LoanError::InsufficientCollateral);

    let offer_key = offer.key();
    let offer_id = offer.offer_id;
    let lender = offer.lender;
    let bump = offer.bump;
    let principal = ctx.accounts.usdc_vault.amount;
    let collateral = offer.collateral_amount;

    let seeds = &[
        OFFER_SEED,
        lender.as_ref(),
        &offer_id.to_le_bytes(),
        &[bump],
    ];
    let signer = &[&seeds[..]];

    if principal > 0 {
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

    let offer = &mut ctx.accounts.offer;
    offer.borrower = ctx.accounts.borrower.key();
    offer.start_ts = clock.unix_timestamp;
    offer.expiry_ts = clock
        .unix_timestamp
        .checked_add(offer.duration_seconds)
        .ok_or(LoanError::MathOverflow)?;
    offer.status = OfferStatus::Filled;

    emit!(OfferAccepted {
        offer: offer_key,
        borrower: offer.borrower,
        start_ts: offer.start_ts,
        expiry_ts: offer.expiry_ts,
    });

    Ok(())
}
