use crate::constants::{OFFER_SEED, REQUEST_SEED, REQUEST_WSOL_VAULT_SEED, USDC_VAULT_SEED, WSOL_VAULT_SEED};
use crate::error::LoanError;
use crate::state::{LoanRequest, Offer, OfferStatus, RequestStatus};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};
use loan_core::constants::mints_allowed;

#[derive(Accounts)]
#[instruction(offer_id: u64)]
pub struct CreateOffer<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,

    #[account(
        init,
        payer = lender,
        space = 8 + Offer::INIT_SPACE,
        seeds = [OFFER_SEED, lender.key().as_ref(), &offer_id.to_le_bytes()],
        bump,
    )]
    pub offer: Box<Account<'info, Offer>>,

    #[account(constraint = usdc_mint.decimals == 6 @ LoanError::InvalidUsdcMint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        constraint = wsol_mint.decimals == 9 @ LoanError::InvalidWsolMint,
        constraint = wsol_mint.key() != usdc_mint.key() @ LoanError::SameMint,
        constraint = mints_allowed(&usdc_mint.key(), &wsol_mint.key()) @ LoanError::MintNotAllowed,
    )]
    pub wsol_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = lender,
        token::mint = usdc_mint,
        token::authority = offer,
        seeds = [USDC_VAULT_SEED, offer.key().as_ref()],
        bump,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = lender,
    )]
    pub lender_usdc: Account<'info, TokenAccount>,

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
        seeds = [OFFER_SEED, lender.key().as_ref(), &offer.offer_id.to_le_bytes()],
        bump = offer.bump,
        has_one = lender @ LoanError::UnauthorizedLender,
        constraint = offer.status == OfferStatus::Open @ LoanError::WrongStatus,
    )]
    pub offer: Box<Account<'info, Offer>>,

    #[account(
        mut,
        seeds = [USDC_VAULT_SEED, offer.key().as_ref()],
        bump,
        token::mint = offer.usdc_mint,
        token::authority = offer,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = offer.usdc_mint,
        token::authority = lender,
    )]
    pub lender_usdc: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,

    #[account(
        mut,
        constraint = offer.status == OfferStatus::Open @ LoanError::WrongStatus,
        has_one = lender @ LoanError::UnauthorizedLender,
    )]
    pub offer: Box<Account<'info, Offer>>,

    /// Receives the USDC vault rent the lender paid at create.
    #[account(mut)]
    pub lender: SystemAccount<'info>,

    /// CHECK: Pyth price update account owned by the receiver program.
    pub price_update: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [USDC_VAULT_SEED, offer.key().as_ref()],
        bump,
        token::mint = offer.usdc_mint,
        token::authority = offer,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(
        constraint = wsol_mint.key() == offer.wsol_mint @ LoanError::InvalidTerms,
    )]
    pub wsol_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = borrower,
        token::mint = wsol_mint,
        token::authority = offer,
        seeds = [WSOL_VAULT_SEED, offer.key().as_ref()],
        bump,
    )]
    pub wsol_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = offer.usdc_mint,
        associated_token::authority = borrower,
    )]
    pub borrower_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = offer.wsol_mint,
        associated_token::authority = borrower,
    )]
    pub borrower_wsol: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RepayLoan<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,

    #[account(
        mut,
        constraint = offer.status == OfferStatus::Filled @ LoanError::WrongStatus,
        has_one = borrower @ LoanError::UnauthorizedBorrower,
    )]
    pub offer: Box<Account<'info, Offer>>,

    #[account(
        mut,
        seeds = [WSOL_VAULT_SEED, offer.key().as_ref()],
        bump,
        token::mint = offer.wsol_mint,
        token::authority = offer,
    )]
    pub wsol_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = offer.usdc_mint,
        token::authority = borrower,
    )]
    pub borrower_usdc: Account<'info, TokenAccount>,

    /// CHECK: Lender pubkey from the offer.
    #[account(address = offer.lender)]
    pub lender: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = offer.usdc_mint,
        token::authority = lender,
    )]
    pub lender_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = offer.wsol_mint,
        token::authority = borrower,
    )]
    pub borrower_wsol: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimExpiredLoan<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        constraint = offer.status == OfferStatus::Filled @ LoanError::WrongStatus,
    )]
    pub offer: Box<Account<'info, Offer>>,

    #[account(
        mut,
        seeds = [WSOL_VAULT_SEED, offer.key().as_ref()],
        bump,
        token::mint = offer.wsol_mint,
        token::authority = offer,
    )]
    pub wsol_vault: Account<'info, TokenAccount>,

    /// CHECK: Lender from offer.
    #[account(address = offer.lender)]
    pub lender: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = offer.wsol_mint,
        token::authority = lender,
    )]
    pub lender_wsol: Account<'info, TokenAccount>,

    /// Receives the wSOL vault rent the borrower paid at accept.
    #[account(mut, address = offer.borrower)]
    pub borrower: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct LiquidateLoan<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        constraint = offer.status == OfferStatus::Filled @ LoanError::WrongStatus,
    )]
    pub offer: Box<Account<'info, Offer>>,

    /// CHECK: Pyth price update owned by receiver.
    pub price_update: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [WSOL_VAULT_SEED, offer.key().as_ref()],
        bump,
        token::mint = offer.wsol_mint,
        token::authority = offer,
    )]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = offer.usdc_mint,
        token::authority = caller,
    )]
    pub caller_usdc: Box<Account<'info, TokenAccount>>,

    /// CHECK: Lender from offer.
    #[account(address = offer.lender)]
    pub lender: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = offer.usdc_mint,
        token::authority = lender,
    )]
    pub lender_usdc: Box<Account<'info, TokenAccount>>,

    /// Receives the wSOL vault rent the borrower paid at accept.
    #[account(mut, address = offer.borrower)]
    pub borrower: SystemAccount<'info>,

    #[account(
        mut,
        token::mint = offer.wsol_mint,
        token::authority = borrower,
    )]
    pub borrower_wsol: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = offer.wsol_mint,
        token::authority = caller,
    )]
    pub caller_wsol: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseOffer<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,

    #[account(
        mut,
        seeds = [OFFER_SEED, lender.key().as_ref(), &offer.offer_id.to_le_bytes()],
        bump = offer.bump,
        has_one = lender @ LoanError::UnauthorizedLender,
        constraint = matches!(
            offer.status,
            OfferStatus::Repaid | OfferStatus::Expired | OfferStatus::Liquidated | OfferStatus::Cancelled
        ) @ LoanError::OfferNotSettled,
        close = lender,
    )]
    pub offer: Box<Account<'info, Offer>>,
}

#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct CreateRequest<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,

    #[account(
        init,
        payer = borrower,
        space = 8 + LoanRequest::INIT_SPACE,
        seeds = [REQUEST_SEED, borrower.key().as_ref(), &request_id.to_le_bytes()],
        bump,
    )]
    pub request: Box<Account<'info, LoanRequest>>,

    #[account(constraint = usdc_mint.decimals == 6 @ LoanError::InvalidUsdcMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(
        constraint = wsol_mint.decimals == 9 @ LoanError::InvalidWsolMint,
        constraint = wsol_mint.key() != usdc_mint.key() @ LoanError::SameMint,
        constraint = mints_allowed(&usdc_mint.key(), &wsol_mint.key()) @ LoanError::MintNotAllowed,
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

    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = borrower,
    )]
    pub borrower_wsol: Box<Account<'info, TokenAccount>>,

    /// Must exist so funding never has to create it for the borrower.
    #[account(
        associated_token::mint = usdc_mint,
        associated_token::authority = borrower,
    )]
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
        seeds = [REQUEST_SEED, borrower.key().as_ref(), &request.request_id.to_le_bytes()],
        bump = request.bump,
        has_one = borrower @ LoanError::UnauthorizedBorrower,
        constraint = request.status == RequestStatus::Open @ LoanError::WrongStatus,
    )]
    pub request: Box<Account<'info, LoanRequest>>,

    #[account(
        mut,
        seeds = [REQUEST_WSOL_VAULT_SEED, request.key().as_ref()],
        bump,
        token::mint = request.wsol_mint,
        token::authority = request,
    )]
    pub request_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = request.wsol_mint,
        token::authority = borrower,
    )]
    pub borrower_wsol: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(offer_id: u64)]
pub struct FundRequest<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,

    #[account(
        mut,
        seeds = [REQUEST_SEED, request.borrower.as_ref(), &request.request_id.to_le_bytes()],
        bump = request.bump,
        constraint = request.status == RequestStatus::Open @ LoanError::WrongStatus,
    )]
    pub request: Box<Account<'info, LoanRequest>>,

    /// CHECK: Borrower from the request; only receives USDC through its ATA.
    #[account(address = request.borrower)]
    pub borrower: UncheckedAccount<'info>,

    /// CHECK: Pyth price update account owned by the receiver program.
    pub price_update: UncheckedAccount<'info>,

    #[account(
        init,
        payer = lender,
        space = 8 + Offer::INIT_SPACE,
        seeds = [OFFER_SEED, lender.key().as_ref(), &offer_id.to_le_bytes()],
        bump,
    )]
    pub offer: Box<Account<'info, Offer>>,

    #[account(constraint = wsol_mint.key() == request.wsol_mint @ LoanError::InvalidTerms)]
    pub wsol_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [REQUEST_WSOL_VAULT_SEED, request.key().as_ref()],
        bump,
        token::mint = request.wsol_mint,
        token::authority = request,
    )]
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

    #[account(
        mut,
        token::mint = request.usdc_mint,
        token::authority = lender,
    )]
    pub lender_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = request.usdc_mint,
        associated_token::authority = borrower,
    )]
    pub borrower_usdc: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseRequest<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,

    #[account(
        mut,
        seeds = [REQUEST_SEED, borrower.key().as_ref(), &request.request_id.to_le_bytes()],
        bump = request.bump,
        has_one = borrower @ LoanError::UnauthorizedBorrower,
        constraint = matches!(
            request.status,
            RequestStatus::Funded | RequestStatus::Cancelled
        ) @ LoanError::RequestNotSettled,
        close = borrower,
    )]
    pub request: Box<Account<'info, LoanRequest>>,
}

#[event]
pub struct RequestCreated {
    pub request: Pubkey,
    pub borrower: Pubkey,
    pub request_id: u64,
    pub principal: u64,
    pub collateral: u64,
}

#[event]
pub struct RequestCancelled {
    pub request: Pubkey,
}

#[event]
pub struct RequestFunded {
    pub request: Pubkey,
    pub offer: Pubkey,
    pub lender: Pubkey,
    pub borrower: Pubkey,
    pub start_ts: i64,
    pub expiry_ts: i64,
}

#[event]
pub struct RequestClosed {
    pub request: Pubkey,
}

#[event]
pub struct OfferClosed {
    pub offer: Pubkey,
}

#[event]
pub struct OfferCreated {
    pub offer: Pubkey,
    pub lender: Pubkey,
    pub offer_id: u64,
    pub principal: u64,
}

#[event]
pub struct OfferCancelled {
    pub offer: Pubkey,
}

#[event]
pub struct OfferAccepted {
    pub offer: Pubkey,
    pub borrower: Pubkey,
    pub start_ts: i64,
    pub expiry_ts: i64,
}

#[event]
pub struct LoanRepaid {
    pub offer: Pubkey,
    pub debt: u64,
}

#[event]
pub struct LoanExpiredEvent {
    pub offer: Pubkey,
    pub collateral: u64,
}

#[event]
pub struct LoanLiquidated {
    pub offer: Pubkey,
    pub caller: Pubkey,
    pub debt: u64,
    pub to_caller: u64,
    pub to_borrower: u64,
}
