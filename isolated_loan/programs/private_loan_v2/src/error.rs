use anchor_lang::prelude::*;

#[error_code]
pub enum PrivateLoanError {
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Interest rate, term, or LTV is outside allowed caps")]
    InvalidTerms,
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
    #[msg("Signer may not perform this action")]
    Unauthorized,
    #[msg("Record is missing or malformed")]
    InvalidRecord,
    #[msg("Only the room owner may perform this action")]
    NotRoomOwner,
    #[msg("Room is already initialized")]
    RoomAlreadyInitialized,
    #[msg("Signer is not an active member of this room")]
    NotMember,
    #[msg("Wallet is already a member of this room")]
    AlreadyMember,
    #[msg("Room has no free member slots")]
    RoomFull,
    #[msg("Roles must be a non-empty combination of borrower, lender and viewer")]
    InvalidRole,
    #[msg("The room owner cannot be revoked")]
    CannotRevokeOwner,
    #[msg("Session must expire in the future and within one day")]
    SessionTooLong,
    #[msg("Session does not cover this room or action")]
    SessionScope,
    #[msg("Session has been revoked")]
    SessionRevoked,
    #[msg("Session has expired")]
    SessionExpired,
    #[msg("Message must be 1 to 140 bytes")]
    MessageTooLong,
    #[msg("Loan does not belong to this room")]
    WrongRoom,
    #[msg("Signer is not this loan's lender")]
    NotLender,
    #[msg("Signer is not this loan's borrower")]
    NotBorrower,
    #[msg("Loan is not in the required status")]
    WrongStatus,
    #[msg("Terms changed since this approval; review the current revision")]
    StaleRevision,
    #[msg("Token account is not the expected one for this party and mint")]
    WrongTokenAccount,
    #[msg("Collateral is insufficient for the max LTV at the current price")]
    InsufficientCollateral,
    #[msg("Loan is expired; it can only be claimed")]
    LoanExpired,
    #[msg("Loan is not expired yet")]
    LoanNotExpired,
    #[msg("The borrower already accepted another offer for this request")]
    CompetingOfferAccepted,
    #[msg("The AI copilot is turned off")]
    AiDisabled,
    #[msg("Only the configured AI worker may answer")]
    NotAiWorker,
    #[msg("This request was already answered")]
    AlreadyAnswered,
    #[msg("This request expired before an answer arrived")]
    RequestExpired,
    #[msg("This ticket can still execute; wait until the quote expires or moves on")]
    TicketInPlay,
    #[msg("Only canonical USDC and wrapped SOL are accepted")]
    MintNotAllowed,
    #[msg("Signer does not hold the authority this action needs")]
    WrongAuthority,
    #[msg("Authorities must all be set and distinct")]
    InvalidAuthorities,
    #[msg("Only the program's upgrade authority can initialize the config")]
    NotUpgradeAuthority,
    #[msg("This settlement is not available yet")]
    TooEarly,
    #[msg("Amount must be above zero")]
    ZeroAmount,
    #[msg("Loan is healthy and cannot be liquidated")]
    LoanHealthy,
    #[msg("The desk policy is incomplete or inconsistent")]
    InvalidPolicy,
    #[msg("These terms are outside the desk's policy")]
    PolicyViolation,
    #[msg("Only a desk administrator may perform this action")]
    NotDeskAdmin,
    #[msg("Only a desk lender may originate under this desk")]
    NotDeskLender,
    #[msg("A desk must keep at least one administrator")]
    LastDeskAdmin,
    #[msg("The auditor audience differs from the one shown for signing")]
    AuditorMismatch,
    // Story 26.1. Appended so existing error codes do not move.
    #[msg("New principal is above the old loan's payoff; refinancing never pays cash out")]
    RefinanceCashOut,
    #[msg("Only Active and Grace loans can refinance")]
    RefinanceClosed,
    #[msg("The new loan must lend the same asset against the same collateral")]
    RefinanceMismatch,
    #[msg("Payment exceeds the bound the borrower signed")]
    PaymentAboveLimit,
}

pub fn core_error(e: loan_core::CoreError) -> Error {
    use loan_core::CoreError as C;
    match e {
        C::MathOverflow => error!(PrivateLoanError::MathOverflow),
        C::InvalidTerms => error!(PrivateLoanError::InvalidTerms),
        C::InvalidPriceOwner => error!(PrivateLoanError::InvalidPriceOwner),
        C::InvalidFeedId => error!(PrivateLoanError::InvalidFeedId),
        C::StalePrice => error!(PrivateLoanError::StalePrice),
        C::InvalidPrice => error!(PrivateLoanError::InvalidPrice),
        C::InvalidExponent => error!(PrivateLoanError::InvalidExponent),
        C::ZeroCollateralValue => error!(PrivateLoanError::ZeroCollateralValue),
    }
}

pub fn governance_error(e: governance::GovernanceError) -> Error {
    match e {
        governance::GovernanceError::WrongAuthority => error!(PrivateLoanError::WrongAuthority),
        _ => error!(PrivateLoanError::InvalidAuthorities),
    }
}
