use crate::contexts::{ClaimExpiredLoan, LoanExpiredEvent};
use crate::constants::OFFER_SEED;
use crate::error::LoanError;
use crate::state::OfferStatus;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Transfer};

pub fn handler(ctx: Context<ClaimExpiredLoan>) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= ctx.accounts.offer.expiry_ts,
        LoanError::LoanNotExpired
    );

    let offer_key = ctx.accounts.offer.key();
    let offer_id = ctx.accounts.offer.offer_id;
    let lender = ctx.accounts.offer.lender;
    let bump = ctx.accounts.offer.bump;
    let wsol_amount = ctx.accounts.wsol_vault.amount;

    let seeds = &[
        OFFER_SEED,
        lender.as_ref(),
        &offer_id.to_le_bytes(),
        &[bump],
    ];
    let signer = &[&seeds[..]];

    if wsol_amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.wsol_vault.to_account_info(),
                    to: ctx.accounts.lender_wsol.to_account_info(),
                    authority: ctx.accounts.offer.to_account_info(),
                },
                signer,
            ),
            wsol_amount,
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

    ctx.accounts.offer.status = OfferStatus::Expired;

    emit!(LoanExpiredEvent {
        offer: offer_key,
        collateral: wsol_amount,
    });

    Ok(())
}
