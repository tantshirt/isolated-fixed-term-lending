use crate::contexts::{CancelRequest, RequestCancelled};
use crate::constants::REQUEST_SEED;
use crate::state::RequestStatus;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Transfer};

pub fn handler(ctx: Context<CancelRequest>) -> Result<()> {
    let request_key = ctx.accounts.request.key();
    let request_id = ctx.accounts.request.request_id;
    let bump = ctx.accounts.request.bump;
    let borrower = ctx.accounts.borrower.key();
    let amount = ctx.accounts.request_vault.amount;

    let seeds = &[
        REQUEST_SEED,
        borrower.as_ref(),
        &request_id.to_le_bytes(),
        &[bump],
    ];
    let signer = &[&seeds[..]];

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

    ctx.accounts.request.status = RequestStatus::Cancelled;

    emit!(RequestCancelled { request: request_key });

    Ok(())
}
