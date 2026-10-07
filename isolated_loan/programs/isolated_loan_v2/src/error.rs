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
    #[msg("Price feed id does not match the collateral's feed")]
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
    // Story 26.2. Appended so existing error codes do not move.
    #[msg("This collateral mint has no governance CollateralConfig")]
    CollateralNotConfigured,
    #[msg("This collateral is disabled for new loans")]
    CollateralDisabled,
    #[msg("Collateral config is invalid")]
    InvalidCollateralConfig,
    #[msg("Signer does not hold the required authority")]
    WrongAuthority,
    #[msg("Authorities are unset or share a key")]
    InvalidAuthorities,
    #[msg("Only the program upgrade authority can initialize the config")]
    NotUpgradeAuthority,
    // Story 26.1. Appended so existing error codes do not move.
    #[msg("New principal is above the old loan's payoff; refinancing never pays cash out")]
    RefinanceCashOut,
    #[msg("Only Active and Grace loans can refinance")]
    RefinanceClosed,
    #[msg("The new offer must lend the same asset against the same collateral")]
    RefinanceMismatch,
    // Story 26.3. Appended so existing error codes do not move.
    #[msg("Mandate bounds are missing, inconsistent or outside the loan's limits")]
    MandateInvalid,
    #[msg("Mandate has expired")]
    MandateExpired,
    #[msg("Mandate trigger is not met, or it fired and has not re-armed")]
    MandateNotTriggered,
    #[msg("Mandate cumulative cap is used up")]
    MandateCapReached,
    #[msg("Keeper fee is above the per-execution fee or the fee cap")]
    MandateFeeAboveCap,
    #[msg("The source token account no longer delegates enough to this mandate")]
    MandateDelegateRevoked,
    #[msg("Account does not match the mandate's loan, borrower or asset")]
    MandateWrongSource,
    // ---- Story 26.7 (credit tiers). Appended as one block so existing codes do not move. ----
    #[msg("Credit-tier terms need a valid credential of at least that tier")]
    CreditTierRequired,
    #[msg("Credit-tier terms are invite-only: a wSOL offer restricted to one borrower")]
    CreditNotInvited,
    #[msg("The credit pilot is disabled or its config accounts are missing")]
    CreditDisabled,
    #[msg("Credit config is invalid")]
    InvalidCreditConfig,
    // ---- end Story 26.7 ----
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
