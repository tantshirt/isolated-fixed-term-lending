//! Secondary market (Story 26.8). Every V2 position is sellable: a lender lists it at a USDC
//! price and a buyer takes it atomically. The borrower's terms never change; only
//! `current_lender` (who is paid) moves. The vault PDAs keep signing with `origin_lender`.
//!
//! - `list_position(price, expiry)`: the current lender, while the loan is Active and in its
//!   Active or Grace phase. One listing per loan (`["listing", offer]`); listing again updates it.
//! - `cancel_listing`: the seller closes it and reclaims the rent.
//! - `buy_position(expected_price, expected_paid)`: the buyer pays exactly the listed price to the seller and
//!   becomes `current_lender`; the listing closes (rent to the seller). Rejects a stale listing
//!   (seller no longer the current lender), an expired one, a settled loan, an overdue loan, and
//!   a price or cumulative payment state that differs from what the buyer signed.
//! - `close_listing`: anyone, once the listing is void (loan settled or closed, seller no longer
//!   the current lender, or expired); the rent returns to the seller.

use crate::contexts::OFFER_SEED;
use crate::error::LoanV2Error;
use crate::state::{OfferV2, StatusV2};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use loan_core::accounting::{self as acc, Phase};

pub const LISTING_SEED: &[u8] = b"listing";

/// One open sale of one V2 position.
#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub offer: Pubkey,
    /// The `current_lender` when listed; the listing is void once that changes.
    pub seller: Pubkey,
    /// USDC atoms the buyer pays the seller.
    pub price: u64,
    /// Unix seconds; buyable while `now < expiry`.
    pub expiry: i64,
    pub bump: u8,
    pub reserved: [u8; 32],
}

/// Sellable while Active and before grace ends. Overdue and later phases belong to recovery.
fn sellable(o: &OfferV2, now: i64) -> Result<()> {
    require!(o.status == StatusV2::Active, LoanV2Error::WrongStatus);
    let terms = o.terms.core()?;
    require!(matches!(acc::phase(&terms, now), Phase::Active | Phase::Grace), LoanV2Error::PositionNotSellable);
    Ok(())
}

pub fn list_position(ctx: Context<ListPosition>, price: u64, expiry: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(price > 0, LoanV2Error::ZeroAmount);
    require!(expiry > now, LoanV2Error::ListingExpired);
    sellable(&ctx.accounts.offer, now)?;
    let (offer, seller) = (ctx.accounts.offer.key(), ctx.accounts.seller.key());
    let l = &mut ctx.accounts.listing;
    l.offer = offer;
    l.seller = seller;
    l.price = price;
    l.expiry = expiry;
    l.bump = ctx.bumps.listing;
    l.reserved = [0; 32];
    emit!(PositionListedV2 { offer, seller, price, expiry });
    Ok(())
}

pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
    emit!(ListingClosedV2 { offer: ctx.accounts.listing.offer, seller: ctx.accounts.listing.seller, cancelled: true });
    Ok(())
}

/// Cumulative payment state reviewed by the buyer. Accrual alone cannot change it, but every
/// nonzero repayment (including interest-only and late-fee-only payments) does. No account layout
/// change is needed; u128 avoids overflow when summing the ledger's u64 counters.
pub fn paid_snapshot(o: &OfferV2) -> Result<u128> {
    let principal_paid = o.terms.principal.checked_sub(o.ledger.outstanding_principal).ok_or(LoanV2Error::InvalidListing)?;
    Ok(u128::from(principal_paid) + u128::from(o.ledger.interest_paid) + u128::from(o.ledger.late_fee_paid))
}

pub fn buy_position(ctx: Context<BuyPosition>, expected_price: u64, expected_paid: u128) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (l, o) = (&ctx.accounts.listing, &ctx.accounts.offer);
    sellable(o, now)?;
    require_keys_eq!(l.seller, o.current_lender, LoanV2Error::StaleListing);
    require!(now < l.expiry, LoanV2Error::ListingExpired);
    require!(l.price == expected_price, LoanV2Error::ListingPriceChanged);
    require!(paid_snapshot(o)? == expected_paid, LoanV2Error::InvalidListing);
    let buyer = ctx.accounts.buyer.key();
    require!(buyer != o.borrower, LoanV2Error::SameBorrowerAndLender);
    require!(buyer != l.seller, LoanV2Error::InvalidListing);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.buyer_usdc.to_account_info(),
                to: ctx.accounts.seller_usdc.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        l.price,
    )?;
    let (offer, seller, price) = (o.key(), l.seller, l.price);
    ctx.accounts.offer.current_lender = buyer;
    emit!(PositionSoldV2 { offer, seller, buyer, price });
    Ok(())
}

pub fn close_listing(ctx: Context<CloseListing>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let l = &ctx.accounts.listing;
    let info = ctx.accounts.offer.to_account_info();
    let void = if info.owner != &crate::ID || info.data_is_empty() {
        true
    } else {
        let o = OfferV2::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        o.status.is_settled() || o.current_lender != l.seller || now >= l.expiry
            || (o.status == StatusV2::Active && !matches!(acc::phase(&o.terms.core()?, now), Phase::Active | Phase::Grace))
    };
    require!(void, LoanV2Error::ListingStillValid);
    emit!(ListingClosedV2 { offer: l.offer, seller: l.seller, cancelled: false });
    Ok(())
}

#[derive(Accounts)]
pub struct ListPosition<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        constraint = offer.current_lender == seller.key() @ LoanV2Error::UnauthorizedLender,
        seeds = [OFFER_SEED, offer.origin_lender.as_ref(), &offer.offer_id.to_le_bytes()],
        bump = offer.bump,
    )]
    pub offer: Box<Account<'info, OfferV2>>,
    /// Re-listing by the same seller updates price and expiry in place.
    #[account(
        init_if_needed,
        payer = seller,
        space = 8 + Listing::INIT_SPACE,
        seeds = [LISTING_SEED, offer.key().as_ref()],
        bump,
    )]
    pub listing: Box<Account<'info, Listing>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelListing<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        has_one = seller @ LoanV2Error::UnauthorizedLender,
        seeds = [LISTING_SEED, listing.offer.as_ref()],
        bump = listing.bump,
        close = seller,
    )]
    pub listing: Box<Account<'info, Listing>>,
}

#[derive(Accounts)]
pub struct BuyPosition<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [OFFER_SEED, offer.origin_lender.as_ref(), &offer.offer_id.to_le_bytes()],
        bump = offer.bump,
    )]
    pub offer: Box<Account<'info, OfferV2>>,
    #[account(
        mut,
        has_one = offer @ LoanV2Error::InvalidListing,
        seeds = [LISTING_SEED, offer.key().as_ref()],
        bump = listing.bump,
        close = seller,
    )]
    pub listing: Box<Account<'info, Listing>>,
    /// Receives the listing rent; the price goes to `seller_usdc`.
    #[account(mut, address = listing.seller @ LoanV2Error::StaleListing)]
    pub seller: SystemAccount<'info>,
    #[account(mut, token::mint = offer.usdc_mint, token::authority = seller)]
    pub seller_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = offer.usdc_mint, token::authority = buyer)]
    pub buyer_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseListing<'info> {
    #[account(
        mut,
        seeds = [LISTING_SEED, listing.offer.as_ref()],
        bump = listing.bump,
        close = seller,
    )]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: the listed loan. It may already be closed by `close_offer`; read in the handler.
    #[account(address = listing.offer @ LoanV2Error::InvalidListing)]
    pub offer: UncheckedAccount<'info>,
    #[account(mut, address = listing.seller @ LoanV2Error::InvalidListing)]
    pub seller: SystemAccount<'info>,
}

#[event]
pub struct PositionListedV2 {
    pub offer: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    pub expiry: i64,
}

#[event]
pub struct PositionSoldV2 {
    pub offer: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
}

#[event]
pub struct ListingClosedV2 {
    pub offer: Pubkey,
    pub seller: Pubkey,
    /// True when the seller cancelled; false when anyone closed a void listing.
    pub cancelled: bool,
}
