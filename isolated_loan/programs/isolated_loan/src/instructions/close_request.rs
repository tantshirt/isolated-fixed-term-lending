use crate::contexts::{CloseRequest, RequestClosed};
use anchor_lang::prelude::*;

/// Anchor's `close = borrower` returns the request rent. This only records the event.
pub fn handler(ctx: Context<CloseRequest>) -> Result<()> {
    emit!(RequestClosed {
        request: ctx.accounts.request.key(),
    });
    Ok(())
}
