//! Loan math and price checks shared by `isolated_loan` and `private_loan`.
//!
//! Functions return `CoreError`. Each program maps it onto its own Anchor
//! error enum, so both programs keep their own error codes.

pub mod constants;
pub mod math;
pub mod oracle;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreError {
    MathOverflow,
    InvalidTerms,
    InvalidPriceOwner,
    InvalidFeedId,
    StalePrice,
    InvalidPrice,
    InvalidExponent,
    ZeroCollateralValue,
}

pub type CoreResult<T> = core::result::Result<T, CoreError>;
