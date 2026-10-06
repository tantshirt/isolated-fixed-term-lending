use anchor_lang::prelude::*;

#[error_code]
pub enum LoanError {
    #[msg("Offer is not in the required status")]
    WrongStatus,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Collateral is insufficient for the max LTV at the current price")]
    InsufficientCollateral,
    #[msg("Loan is healthy and cannot be liquidated")]
    LoanHealthy,
    #[msg("Only the lender may perform this action")]
    UnauthorizedLender,
    #[msg("Only the borrower may perform this action")]
    UnauthorizedBorrower,
    #[msg("Borrower and lender must be different")]
    SameBorrowerAndLender,
    #[msg("Borrower cannot liquidate their own loan")]
    BorrowerCannotLiquidate,
    #[msg("Interest rate, term, or LTV is outside allowed caps")]
    InvalidTerms,
    #[msg("Loan is expired; use claim instead")]
    LoanExpired,
    #[msg("Loan is not expired yet")]
    LoanNotExpired,
    #[msg("Price feed owner is invalid")]
    InvalidPriceOwner,
    #[msg("Price feed id does not match SOL/USD")]
    InvalidFeedId,
    #[msg("Price is stale")]
    StalePrice,
    #[msg("Price confidence is too wide or price is non-positive")]
    InvalidPrice,
    #[msg("Price exponent is outside the allowed range")]
    InvalidExponent,
    #[msg("Collateral value is zero")]
    ZeroCollateralValue,
    #[msg("USDC mint must have 6 decimals")]
    InvalidUsdcMint,
    #[msg("wSOL mint must have 9 decimals")]
    InvalidWsolMint,
    #[msg("USDC and wSOL mints must differ")]
    SameMint,
    #[msg("Offer must be settled before it can be closed")]
    OfferNotSettled,
    #[msg("Request must be funded or cancelled before it can be closed")]
    RequestNotSettled,
    #[msg("Only canonical USDC and wrapped SOL are accepted")]
    MintNotAllowed,
}

pub fn core_error(e: loan_core::CoreError) -> Error {
    use loan_core::CoreError as C;
    match e {
        C::MathOverflow => error!(LoanError::MathOverflow),
        C::InvalidTerms => error!(LoanError::InvalidTerms),
        C::InvalidPriceOwner => error!(LoanError::InvalidPriceOwner),
        C::InvalidFeedId => error!(LoanError::InvalidFeedId),
        C::StalePrice => error!(LoanError::StalePrice),
        C::InvalidPrice => error!(LoanError::InvalidPrice),
        C::InvalidExponent => error!(LoanError::InvalidExponent),
        C::ZeroCollateralValue => error!(LoanError::ZeroCollateralValue),
    }
}
