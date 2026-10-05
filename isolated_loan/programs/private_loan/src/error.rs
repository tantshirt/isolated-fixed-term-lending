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
    #[msg("Only the probe authority may perform this action")]
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
    #[msg("Role must be borrower, lender, or viewer")]
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
    #[msg("The borrower already accepted another offer in this room")]
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
