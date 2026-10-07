use anchor_lang::prelude::*;

#[error_code]
pub enum LoanV2Error {
    #[msg("Loan is not in the required status")]
    WrongStatus,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Collateral is insufficient for the max LTV of the maximum exposure")]
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
    #[msg("Terms are outside the allowed caps or above the pricing ceiling")]
    InvalidTerms,
    #[msg("This settlement is not available yet")]
    TooEarly,
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
    #[msg("Only canonical USDC and wrapped SOL are accepted")]
    MintNotAllowed,
    #[msg("Account must be settled before it can be closed")]
    NotSettled,
    #[msg("This offer is reserved for another borrower")]
    RestrictedBorrower,
    #[msg("Amount must be above zero")]
    ZeroAmount,
    #[msg("Payment exceeds the slippage bound the borrower signed")]
    PaymentAboveLimit,
}

pub fn core_error(e: loan_core::CoreError) -> Error {
    use loan_core::CoreError as C;
    match e {
        C::MathOverflow => error!(LoanV2Error::MathOverflow),
        C::InvalidTerms => error!(LoanV2Error::InvalidTerms),
        C::InvalidPriceOwner => error!(LoanV2Error::InvalidPriceOwner),
        C::InvalidFeedId => error!(LoanV2Error::InvalidFeedId),
        C::StalePrice => error!(LoanV2Error::StalePrice),
        C::InvalidPrice => error!(LoanV2Error::InvalidPrice),
        C::InvalidExponent => error!(LoanV2Error::InvalidExponent),
        C::ZeroCollateralValue => error!(LoanV2Error::ZeroCollateralValue),
    }
}
