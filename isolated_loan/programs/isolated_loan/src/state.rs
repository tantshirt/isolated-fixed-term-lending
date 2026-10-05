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

impl Offer {
    pub fn debt(&self) -> Result<u64> {
        math::debt(self.principal, self.interest_bps)
    }
}

pub mod math {
    use super::LoanError;
    use anchor_lang::prelude::*;

    pub fn interest(principal: u64, interest_bps: u16) -> Result<u64> {
        let p = principal as u128;
        let bps = interest_bps as u128;
        let interest = p
            .checked_mul(bps)
            .and_then(|v| v.checked_add(9_999))
            .ok_or(error!(LoanError::MathOverflow))?
            / 10_000;
        u64::try_from(interest).map_err(|_| error!(LoanError::MathOverflow))
    }

    pub fn debt(principal: u64, interest_bps: u16) -> Result<u64> {
        let i = interest(principal, interest_bps)?;
        principal
            .checked_add(i)
            .ok_or(error!(LoanError::MathOverflow))
    }

    pub fn collateral_value_usdc(lamports: u64, price: i64, conf: u64, exponent: i32) -> Result<u64> {
        require!(price > 0, LoanError::InvalidPrice);
        require!(conf < price as u64, LoanError::InvalidPrice);
        require!(
            exponent >= crate::constants::MIN_EXPONENT && exponent <= crate::constants::MAX_EXPONENT,
            LoanError::InvalidExponent
        );

        let conservative = (price as u128).checked_sub(conf as u128).ok_or(LoanError::InvalidPrice)?;
        let divisor_exp = 3_i32
            .checked_sub(exponent)
            .ok_or(LoanError::MathOverflow)? as u32;
        let divisor = 10_u128
            .checked_pow(divisor_exp)
            .ok_or(LoanError::MathOverflow)?;

        let num = (lamports as u128)
            .checked_mul(conservative)
            .ok_or(LoanError::MathOverflow)?;
        let value = num / divisor;
        u64::try_from(value).map_err(|_| error!(LoanError::MathOverflow))
    }

    pub fn current_ltv_bps(debt: u64, value_usdc: u64) -> Result<u16> {
        if value_usdc == 0 {
            return Ok(u16::MAX);
        }
        let num = (debt as u128)
            .checked_mul(10_000)
            .ok_or(LoanError::MathOverflow)?;
        let ltv = (num + value_usdc as u128 - 1) / value_usdc as u128;
        // Saturate: a loan far underwater must still read as liquidatable.
        Ok(u16::try_from(ltv).unwrap_or(u16::MAX))
    }

    pub fn health_bps(current_ltv_bps: u16, liquidation_ltv_bps: u16) -> u16 {
        if liquidation_ltv_bps == 0 {
            return 0;
        }
        let health = 10_000_u128
            .saturating_sub((current_ltv_bps as u128 * 10_000) / liquidation_ltv_bps as u128);
        u16::try_from(health).unwrap_or(0)
    }

    pub fn seize_usdc(debt: u64) -> Result<u64> {
        let d = debt as u128;
        let seize = d
            .checked_mul(10_500)
            .and_then(|v| v.checked_add(9_999))
            .ok_or(LoanError::MathOverflow)?
            / 10_000;
        u64::try_from(seize).map_err(|_| error!(LoanError::MathOverflow))
    }

    pub fn wsol_to_caller(lamports: u64, seize_usdc: u64, value_usdc: u64) -> Result<u64> {
        require!(value_usdc > 0, LoanError::ZeroCollateralValue);
        let num = (lamports as u128)
            .checked_mul(seize_usdc as u128)
            .ok_or(LoanError::MathOverflow)?;
        let to_caller = (num + value_usdc as u128 - 1) / value_usdc as u128;
        let capped = to_caller.min(lamports as u128);
        u64::try_from(capped).map_err(|_| error!(LoanError::MathOverflow))
    }

    pub fn validate_terms(
        interest_bps: u16,
        duration_seconds: i64,
        max_ltv_bps: u16,
        liquidation_ltv_bps: u16,
    ) -> Result<()> {
        require!(interest_bps <= crate::constants::MAX_INTEREST_BPS, LoanError::InvalidTerms);
        require!(
            duration_seconds >= crate::constants::MIN_DURATION_SECONDS
                && duration_seconds <= crate::constants::MAX_DURATION_SECONDS,
            LoanError::InvalidTerms
        );
        require!(max_ltv_bps <= crate::constants::MAX_LTV_BPS, LoanError::InvalidTerms);
        require!(
            liquidation_ltv_bps >= max_ltv_bps.saturating_add(crate::constants::MIN_LTV_GAP_BPS),
            LoanError::InvalidTerms
        );
        require!(
            liquidation_ltv_bps <= crate::constants::MAX_LIQUIDATION_LTV_BPS,
            LoanError::InvalidTerms
        );
        Ok(())
    }
}

use crate::error::LoanError;

#[cfg(test)]
mod tests {
    use super::math::*;

    #[test]
    fn worked_example_integers() {
        let price = 15_000_000_000_i64;
        let conf = 15_000_000_u64;
        let exponent = -8_i32;
        let value = collateral_value_usdc(1_000_000_000, price, conf, exponent).unwrap();
        assert_eq!(value, 149_850_000);

        let principal = 100_000_000_u64;
        let interest_bps = 500_u16;
        assert_eq!(interest(principal, interest_bps).unwrap(), 5_000_000);
        assert_eq!(debt(principal, interest_bps).unwrap(), 105_000_000);

        let min_lamports = 1_001_001_002_u64;
        let collateral_value =
            collateral_value_usdc(min_lamports, price, conf, exponent).unwrap();
        assert_eq!(collateral_value, 150_000_000);
        let ltv = current_ltv_bps(105_000_000, collateral_value).unwrap();
        assert_eq!(ltv, 7000);

        let trip_value = 131_250_000_u64;
        let trip_lamports = 875_875_876_u64;
        let trip_collateral =
            collateral_value_usdc(trip_lamports, price, conf, exponent).unwrap();
        assert!(trip_collateral <= trip_value);
        let ltv_at_trip = current_ltv_bps(105_000_000, trip_collateral).unwrap();
        assert!(ltv_at_trip >= 8000);
    }

    #[test]
    fn seize_is_debt_plus_five_percent_rounded_up() {
        assert_eq!(seize_usdc(105_000_000).unwrap(), 110_250_000);
        assert_eq!(seize_usdc(1).unwrap(), 2);
    }

    #[test]
    fn deep_underwater_ltv_saturates() {
        // 105 USDC debt against 1 USDC of collateral is 1_050_000 bps.
        assert_eq!(current_ltv_bps(105_000_000, 1_000_000).unwrap(), u16::MAX);
        assert_eq!(current_ltv_bps(105_000_000, 0).unwrap(), u16::MAX);
    }

    #[test]
    fn caller_share_is_capped_at_vault() {
        // Collateral worth less than the seize amount: caller takes everything.
        assert_eq!(wsol_to_caller(1_000, 110_250_000, 50_000_000).unwrap(), 1_000);
    }
}
