use crate::error::LoanV2Error;
use crate::state::{OfferV2, RequestStatusV2, RequestV2, StatusV2};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};
use loan_core::constants::usdc_allowed;

pub const OFFER_SEED: &[u8] = b"offer-v2";
pub const USDC_VAULT_SEED: &[u8] = b"usdc-vault-v2";
pub const WSOL_VAULT_SEED: &[u8] = b"wsol-vault-v2";
pub const REQUEST_SEED: &[u8] = b"request-v2";
pub const REQUEST_WSOL_VAULT_SEED: &[u8] = b"request-wsol-v2";

#[derive(Accounts)]
#[instruction(offer_id: u64)]
pub struct CreateOffer<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(
        init,
        payer = lender,
        space = 8 + OfferV2::INIT_SPACE,
        seeds = [OFFER_SEED, lender.key().as_ref(), &offer_id.to_le_bytes()],
        bump,
    )]
    pub offer: Box<Account<'info, OfferV2>>,
    #[account(constraint = usdc_mint.decimals == 6 @ LoanV2Error::InvalidUsdcMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// Collateral mint (the field keeps its V2 name). Canonical wSOL, or a mint whose enabled
    /// `CollateralConfig` is the first remaining account; checked in the handler.
    #[account(
        constraint = wsol_mint.key() != usdc_mint.key() @ LoanV2Error::SameMint,
        constraint = usdc_allowed(&usdc_mint.key()) @ LoanV2Error::MintNotAllowed,
    )]
    pub wsol_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = lender,
        token::mint = usdc_mint,
        token::authority = offer,
        seeds = [USDC_VAULT_SEED, offer.key().as_ref()],
        bump,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = lender)]
    pub lender_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOffer<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(
        mut,
        constraint = offer.current_lender == lender.key() @ LoanV2Error::UnauthorizedLender,
        constraint = offer.status == StatusV2::Open @ LoanV2Error::WrongStatus,
    )]
    pub offer: Box<Account<'info, OfferV2>>,
    #[account(mut, seeds = [USDC_VAULT_SEED, offer.key().as_ref()], bump, token::mint = offer.usdc_mint, token::authority = offer)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = offer.usdc_mint, token::authority = lender)]
    pub lender_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(mut, constraint = offer.status == StatusV2::Open @ LoanV2Error::WrongStatus)]
    pub offer: Box<Account<'info, OfferV2>>,
    /// Receives the USDC vault rent the lender paid at create.
    #[account(mut, address = offer.origin_lender)]
    pub lender: SystemAccount<'info>,
    /// CHECK: Pyth price update; owner, feed, age and band are checked in loan-core.
    pub price_update: UncheckedAccount<'info>,
    #[account(mut, seeds = [USDC_VAULT_SEED, offer.key().as_ref()], bump, token::mint = offer.usdc_mint, token::authority = offer)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    #[account(constraint = wsol_mint.key() == offer.wsol_mint @ LoanV2Error::InvalidTerms)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = borrower,
        token::mint = wsol_mint,
        token::authority = offer,
        seeds = [WSOL_VAULT_SEED, offer.key().as_ref()],
        bump,
    )]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = offer.usdc_mint, associated_token::authority = borrower)]
    pub borrower_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = offer.wsol_mint, associated_token::authority = borrower)]
    pub borrower_wsol: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Repay<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(
        mut,
        has_one = borrower @ LoanV2Error::UnauthorizedBorrower,
        constraint = offer.status == StatusV2::Active @ LoanV2Error::WrongStatus,
    )]
    pub offer: Box<Account<'info, OfferV2>>,
    #[account(mut, seeds = [WSOL_VAULT_SEED, offer.key().as_ref()], bump, token::mint = offer.wsol_mint, token::authority = offer)]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = offer.usdc_mint, token::authority = borrower)]
    pub borrower_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: the current lender, who receives every payment.
    #[account(address = offer.current_lender)]
    pub lender: UncheckedAccount<'info>,
    #[account(mut, token::mint = offer.usdc_mint, token::authority = lender)]
    pub lender_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = offer.wsol_mint, token::authority = borrower)]
    pub borrower_wsol: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Story 26.1: the borrower moves an Active or Grace loan (`old_offer`) into an open offer
/// (`new_offer`). Phase, payoff, cash-out and LTV are checked in the handler.
#[derive(Accounts)]
pub struct RefinanceInto<'info> {
    /// Signs every refinance; pays the new collateral vault's rent and receives the old one's.
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(
        mut,
        has_one = borrower @ LoanV2Error::UnauthorizedBorrower,
        constraint = old_offer.status == StatusV2::Active @ LoanV2Error::WrongStatus,
    )]
    pub old_offer: Box<Account<'info, OfferV2>>,
    #[account(mut, seeds = [WSOL_VAULT_SEED, old_offer.key().as_ref()], bump, token::mint = old_offer.wsol_mint, token::authority = old_offer)]
    pub old_wsol_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: the old loan's current lender, who receives the whole payoff.
    #[account(address = old_offer.current_lender)]
    pub old_lender: UncheckedAccount<'info>,
    #[account(mut, token::mint = old_offer.usdc_mint, token::authority = old_lender)]
    pub old_lender_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = new_offer.status == StatusV2::Open @ LoanV2Error::WrongStatus,
        constraint = new_offer.key() != old_offer.key() @ LoanV2Error::RefinanceMismatch,
        constraint = new_offer.usdc_mint == old_offer.usdc_mint @ LoanV2Error::RefinanceMismatch,
        constraint = new_offer.wsol_mint == old_offer.wsol_mint @ LoanV2Error::RefinanceMismatch,
    )]
    pub new_offer: Box<Account<'info, OfferV2>>,
    /// Receives the USDC vault rent the new lender paid at create.
    #[account(mut, address = new_offer.origin_lender)]
    pub new_lender: SystemAccount<'info>,
    #[account(mut, seeds = [USDC_VAULT_SEED, new_offer.key().as_ref()], bump, token::mint = new_offer.usdc_mint, token::authority = new_offer)]
    pub new_usdc_vault: Box<Account<'info, TokenAccount>>,
    /// Receives any USDC in the new offer's vault beyond its principal; refinancing never pays the borrower.
    /// The same account as `old_lender_usdc` in a same-lender rollover. Token accounts are only
    /// written by the token program here, so the duplicate is safe.
    #[account(mut, dup, token::mint = new_offer.usdc_mint, token::authority = new_lender)]
    pub new_lender_usdc: Box<Account<'info, TokenAccount>>,
    #[account(constraint = wsol_mint.key() == old_offer.wsol_mint @ LoanV2Error::RefinanceMismatch)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = borrower,
        token::mint = wsol_mint,
        token::authority = new_offer,
        seeds = [WSOL_VAULT_SEED, new_offer.key().as_ref()],
        bump,
    )]
    pub new_wsol_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = old_offer.usdc_mint, token::authority = borrower)]
    pub borrower_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = old_offer.wsol_mint, token::authority = borrower)]
    pub borrower_wsol: Box<Account<'info, TokenAccount>>,
    /// CHECK: Pyth price update; owner, feed, age and band are checked in loan-core.
    pub price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddCollateral<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(
        mut,
        has_one = borrower @ LoanV2Error::UnauthorizedBorrower,
        constraint = offer.status == StatusV2::Active @ LoanV2Error::WrongStatus,
    )]
    pub offer: Box<Account<'info, OfferV2>>,
    #[account(mut, seeds = [WSOL_VAULT_SEED, offer.key().as_ref()], bump, token::mint = offer.wsol_mint, token::authority = offer)]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = offer.wsol_mint, token::authority = borrower)]
    pub borrower_wsol: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Shared by risk liquidation and overdue liquidation: a third party pays the payoff.
#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, constraint = offer.status == StatusV2::Active @ LoanV2Error::WrongStatus)]
    pub offer: Box<Account<'info, OfferV2>>,
    /// CHECK: Pyth price update; checked in loan-core.
    pub price_update: UncheckedAccount<'info>,
    #[account(mut, seeds = [WSOL_VAULT_SEED, offer.key().as_ref()], bump, token::mint = offer.wsol_mint, token::authority = offer)]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = offer.usdc_mint, token::authority = caller)]
    pub caller_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = offer.wsol_mint, token::authority = caller)]
    pub caller_wsol: Box<Account<'info, TokenAccount>>,
    /// CHECK: the current lender.
    #[account(address = offer.current_lender)]
    pub lender: UncheckedAccount<'info>,
    #[account(mut, token::mint = offer.usdc_mint, token::authority = lender)]
    pub lender_usdc: Box<Account<'info, TokenAccount>>,
    /// Receives the wSOL vault rent it paid at accept.
    #[account(mut, address = offer.borrower)]
    pub borrower: SystemAccount<'info>,
    #[account(mut, token::mint = offer.wsol_mint, token::authority = borrower)]
    pub borrower_wsol: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Priced recovery and the terminal claim: the current lender takes collateral.
#[derive(Accounts)]
pub struct LenderClaim<'info> {
    #[account(mut, address = offer.current_lender @ LoanV2Error::UnauthorizedLender)]
    pub lender: Signer<'info>,
    #[account(mut, constraint = offer.status == StatusV2::Active @ LoanV2Error::WrongStatus)]
    pub offer: Box<Account<'info, OfferV2>>,
    /// CHECK: Pyth price update. Read only by priced recovery; the terminal claim ignores it.
    pub price_update: UncheckedAccount<'info>,
    #[account(mut, seeds = [WSOL_VAULT_SEED, offer.key().as_ref()], bump, token::mint = offer.wsol_mint, token::authority = offer)]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = offer.wsol_mint, token::authority = lender)]
    pub lender_wsol: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = offer.borrower)]
    pub borrower: SystemAccount<'info>,
    #[account(mut, token::mint = offer.wsol_mint, token::authority = borrower)]
    pub borrower_wsol: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseOffer<'info> {
    #[account(mut, address = offer.current_lender @ LoanV2Error::UnauthorizedLender)]
    pub lender: Signer<'info>,
    #[account(mut, constraint = offer.status.is_settled() @ LoanV2Error::NotSettled, close = lender)]
    pub offer: Box<Account<'info, OfferV2>>,
}

#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct CreateRequest<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(
        init,
        payer = borrower,
        space = 8 + RequestV2::INIT_SPACE,
        seeds = [REQUEST_SEED, borrower.key().as_ref(), &request_id.to_le_bytes()],
        bump,
    )]
    pub request: Box<Account<'info, RequestV2>>,
    #[account(constraint = usdc_mint.decimals == 6 @ LoanV2Error::InvalidUsdcMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// Collateral mint (the field keeps its V2 name). Canonical wSOL, or a mint whose enabled
    /// `CollateralConfig` is the first remaining account; checked in the handler.
    #[account(
        constraint = wsol_mint.key() != usdc_mint.key() @ LoanV2Error::SameMint,
        constraint = usdc_allowed(&usdc_mint.key()) @ LoanV2Error::MintNotAllowed,
    )]
    pub wsol_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = borrower,
        token::mint = wsol_mint,
        token::authority = request,
        seeds = [REQUEST_WSOL_VAULT_SEED, request.key().as_ref()],
        bump,
    )]
    pub request_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = wsol_mint, associated_token::authority = borrower)]
    pub borrower_wsol: Box<Account<'info, TokenAccount>>,
    #[account(associated_token::mint = usdc_mint, associated_token::authority = borrower)]
    pub borrower_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelRequest<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(
        mut,
        has_one = borrower @ LoanV2Error::UnauthorizedBorrower,
        constraint = request.status == RequestStatusV2::Open @ LoanV2Error::WrongStatus,
    )]
    pub request: Box<Account<'info, RequestV2>>,
    #[account(mut, seeds = [REQUEST_WSOL_VAULT_SEED, request.key().as_ref()], bump, token::mint = request.wsol_mint, token::authority = request)]
    pub request_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = request.wsol_mint, token::authority = borrower)]
    pub borrower_wsol: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(offer_id: u64)]
pub struct FundRequest<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(mut, constraint = request.status == RequestStatusV2::Open @ LoanV2Error::WrongStatus)]
    pub request: Box<Account<'info, RequestV2>>,
    /// CHECK: the request's borrower; receives USDC through its ATA only.
    #[account(address = request.borrower)]
    pub borrower: UncheckedAccount<'info>,
    /// CHECK: Pyth price update; checked in loan-core.
    pub price_update: UncheckedAccount<'info>,
    #[account(
        init,
        payer = lender,
        space = 8 + OfferV2::INIT_SPACE,
        seeds = [OFFER_SEED, lender.key().as_ref(), &offer_id.to_le_bytes()],
        bump,
    )]
    pub offer: Box<Account<'info, OfferV2>>,
    #[account(constraint = wsol_mint.key() == request.wsol_mint @ LoanV2Error::InvalidTerms)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [REQUEST_WSOL_VAULT_SEED, request.key().as_ref()], bump, token::mint = request.wsol_mint, token::authority = request)]
    pub request_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = lender,
        token::mint = wsol_mint,
        token::authority = offer,
        seeds = [WSOL_VAULT_SEED, offer.key().as_ref()],
        bump,
    )]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = request.usdc_mint, token::authority = lender)]
    pub lender_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = request.usdc_mint, associated_token::authority = borrower)]
    pub borrower_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseRequest<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    #[account(
        mut,
        has_one = borrower @ LoanV2Error::UnauthorizedBorrower,
        constraint = request.status != RequestStatusV2::Open @ LoanV2Error::NotSettled,
        close = borrower,
    )]
    pub request: Box<Account<'info, RequestV2>>,
}
