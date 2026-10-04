use crate::contexts::{CancelOffer, OfferCancelled};
use crate::constants::OFFER_SEED;
use crate::state::OfferStatus;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Transfer};

pub fn handler(ctx: Context<CancelOffer>) -> Result<()> {
    let offer_key = ctx.accounts.offer.key();
    let offer_id = ctx.accounts.offer.offer_id;
    let bump = ctx.accounts.offer.bump;
    let lender = ctx.accounts.lender.key();
    let amount = ctx.accounts.usdc_vault.amount;

    let seeds = &[
        OFFER_SEED,
        lender.as_ref(),
        &offer_id.to_le_bytes(),
        &[bump],
    ];
    let signer = &[&seeds[..]];

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

    ctx.accounts.offer.status = OfferStatus::Cancelled;

    emit!(OfferCancelled { offer: offer_key });

    Ok(())
}
