use crate::contexts::{CloseOffer, OfferClosed};
use anchor_lang::prelude::*;

/// Anchor's `close = lender` returns the offer rent. This only records the event.
pub fn handler(ctx: Context<CloseOffer>) -> Result<()> {
    emit!(OfferClosed {
        offer: ctx.accounts.offer.key(),
    });
    Ok(())
}
