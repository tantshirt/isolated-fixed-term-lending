use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub lender: Pubkey,
    pub borrower: Pubkey,
    pub offer_id: u64,
    pub usdc_mint: Pubkey,
    pub wsol_mint: Pubkey,
    pub principal: u64,
    pub interest_bps: u16,
    pub duration_seconds: i64,
    pub collateral_amount: u64,
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
    pub start_ts: i64,
    pub expiry_ts: i64,
    pub status: OfferStatus,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum OfferStatus {
    Open,
    Filled,
    Repaid,
    Expired,
    Liquidated,
    Cancelled,
}

/// A borrower's public ask. Collateral is locked at create; funding turns it into
/// an ordinary filled `Offer`, so every settlement path is shared.
#[account]
#[derive(InitSpace)]
pub struct LoanRequest {
    pub borrower: Pubkey,
    pub request_id: u64,
    pub usdc_mint: Pubkey,
    pub wsol_mint: Pubkey,
    pub principal: u64,
    pub interest_bps: u16,
    pub duration_seconds: i64,
    pub collateral_amount: u64,
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
    pub created_ts: i64,
    pub status: RequestStatus,
    /// Default until funded.
    pub lender: Pubkey,
    /// The `Offer` created at funding. Default until funded.
    pub offer: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RequestStatus {
    Open,
    Funded,
    Cancelled,
}

impl Offer {
    pub fn debt(&self) -> Result<u64> {
        math::debt(self.principal, self.interest_bps)
    }
}

pub mod math {
    //! Thin wrappers over `loan_core::math` that return this program's errors.
    use crate::error::core_error;
    use anchor_lang::prelude::*;
    use loan_core::math as core;

    pub fn interest(principal: u64, interest_bps: u16) -> Result<u64> {
        core::interest(principal, interest_bps).map_err(core_error)
    }

    pub fn debt(principal: u64, interest_bps: u16) -> Result<u64> {
        core::debt(principal, interest_bps).map_err(core_error)
    }

    pub fn collateral_value_usdc(lamports: u64, price: i64, conf: u64, exponent: i32) -> Result<u64> {
        core::collateral_value_usdc(lamports, price, conf, exponent).map_err(core_error)
    }

    pub fn current_ltv_bps(debt: u64, value_usdc: u64) -> Result<u16> {
        core::current_ltv_bps(debt, value_usdc).map_err(core_error)
    }

    pub use core::health_bps;

    pub fn seize_usdc(debt: u64) -> Result<u64> {
        core::seize_usdc(debt).map_err(core_error)
    }

    pub fn wsol_to_caller(lamports: u64, seize_usdc: u64, value_usdc: u64) -> Result<u64> {
        core::wsol_to_caller(lamports, seize_usdc, value_usdc).map_err(core_error)
    }

    pub fn validate_terms(
        interest_bps: u16,
        duration_seconds: i64,
        max_ltv_bps: u16,
        liquidation_ltv_bps: u16,
    ) -> Result<()> {
        core::validate_terms(interest_bps, duration_seconds, max_ltv_bps, liquidation_ltv_bps)
            .map_err(core_error)
    }
}
