use crate::constants::*;
use crate::{CoreError, CoreResult};

macro_rules! ensure {
    ($cond:expr, $err:expr) => {
        if !$cond {
            return Err($err);
        }
    };
}

pub fn interest(principal: u64, interest_bps: u16) -> CoreResult<u64> {
    let p = principal as u128;
    let bps = interest_bps as u128;
    let interest = p
        .checked_mul(bps)
        .and_then(|v| v.checked_add(9_999))
        .ok_or(CoreError::MathOverflow)?
        / 10_000;
    u64::try_from(interest).map_err(|_| CoreError::MathOverflow)
}

pub fn debt(principal: u64, interest_bps: u16) -> CoreResult<u64> {
    let i = interest(principal, interest_bps)?;
    principal.checked_add(i).ok_or(CoreError::MathOverflow)
}

pub fn collateral_value_usdc(lamports: u64, price: i64, conf: u64, exponent: i32) -> CoreResult<u64> {
    ensure!(price > 0, CoreError::InvalidPrice);
    ensure!(conf < price as u64, CoreError::InvalidPrice);
    ensure!(
        exponent >= MIN_EXPONENT && exponent <= MAX_EXPONENT,
        CoreError::InvalidExponent
    );

    let conservative = (price as u128)
        .checked_sub(conf as u128)
        .ok_or(CoreError::InvalidPrice)?;
    let divisor_exp = 3_i32.checked_sub(exponent).ok_or(CoreError::MathOverflow)? as u32;
    let divisor = 10_u128
        .checked_pow(divisor_exp)
        .ok_or(CoreError::MathOverflow)?;

    let num = (lamports as u128)
        .checked_mul(conservative)
        .ok_or(CoreError::MathOverflow)?;
    let value = num / divisor;
    u64::try_from(value).map_err(|_| CoreError::MathOverflow)
}

pub fn current_ltv_bps(debt: u64, value_usdc: u64) -> CoreResult<u16> {
    if value_usdc == 0 {
        return Ok(u16::MAX);
    }
    let num = (debt as u128)
        .checked_mul(10_000)
        .ok_or(CoreError::MathOverflow)?;
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

pub fn seize_usdc(debt: u64) -> CoreResult<u64> {
    let d = debt as u128;
    let seize = d
        .checked_mul(10_500)
        .and_then(|v| v.checked_add(9_999))
        .ok_or(CoreError::MathOverflow)?
        / 10_000;
    u64::try_from(seize).map_err(|_| CoreError::MathOverflow)
}

pub fn wsol_to_caller(lamports: u64, seize_usdc: u64, value_usdc: u64) -> CoreResult<u64> {
    ensure!(value_usdc > 0, CoreError::ZeroCollateralValue);
    let num = (lamports as u128)
        .checked_mul(seize_usdc as u128)
        .ok_or(CoreError::MathOverflow)?;
    let to_caller = (num + value_usdc as u128 - 1) / value_usdc as u128;
    let capped = to_caller.min(lamports as u128);
    u64::try_from(capped).map_err(|_| CoreError::MathOverflow)
}

pub fn validate_terms(
    interest_bps: u16,
    duration_seconds: i64,
    max_ltv_bps: u16,
    liquidation_ltv_bps: u16,
) -> CoreResult<()> {
    ensure!(interest_bps <= MAX_INTEREST_BPS, CoreError::InvalidTerms);
    ensure!(
        duration_seconds >= MIN_DURATION_SECONDS && duration_seconds <= MAX_DURATION_SECONDS,
        CoreError::InvalidTerms
    );
    ensure!(max_ltv_bps <= MAX_LTV_BPS, CoreError::InvalidTerms);
    ensure!(
        liquidation_ltv_bps >= max_ltv_bps.saturating_add(MIN_LTV_GAP_BPS),
        CoreError::InvalidTerms
    );
    ensure!(
        liquidation_ltv_bps <= MAX_LIQUIDATION_LTV_BPS,
        CoreError::InvalidTerms
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let collateral_value = collateral_value_usdc(min_lamports, price, conf, exponent).unwrap();
        assert_eq!(collateral_value, 150_000_000);
        let ltv = current_ltv_bps(105_000_000, collateral_value).unwrap();
        assert_eq!(ltv, 7000);

        let trip_value = 131_250_000_u64;
        let trip_lamports = 875_875_876_u64;
        let trip_collateral = collateral_value_usdc(trip_lamports, price, conf, exponent).unwrap();
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

#[cfg(test)]
mod shared_vectors {
    use super::*;
    use serde_json::Value;

    fn n(v: &Value) -> u64 {
        v.as_str().unwrap().parse().unwrap()
    }

    #[test]
    fn vectors_json_matches() {
        let doc: Value = serde_json::from_str(include_str!("../vectors.json")).unwrap();
        for c in doc["interest"].as_array().unwrap() {
            let bps = c["interest_bps"].as_u64().unwrap() as u16;
            assert_eq!(interest(n(&c["principal"]), bps).unwrap(), n(&c["interest"]));
            assert_eq!(debt(n(&c["principal"]), bps).unwrap(), n(&c["debt"]));
        }
        for c in doc["collateral_value"].as_array().unwrap() {
            let price = n(&c["price"]) as i64;
            let exp = c["exponent"].as_i64().unwrap() as i32;
            let got = collateral_value_usdc(n(&c["lamports"]), price, n(&c["conf"]), exp).unwrap();
            assert_eq!(got, n(&c["value"]));
        }
        for c in doc["ltv"].as_array().unwrap() {
            let got = current_ltv_bps(n(&c["debt"]), n(&c["value"])).unwrap();
            assert_eq!(got as u64, c["ltv_bps"].as_u64().unwrap());
        }
        for c in doc["seize"].as_array().unwrap() {
            assert_eq!(seize_usdc(n(&c["debt"])).unwrap(), n(&c["seize"]));
        }
        for c in doc["wsol_to_caller"].as_array().unwrap() {
            let got = wsol_to_caller(n(&c["lamports"]), n(&c["seize"]), n(&c["value"])).unwrap();
            assert_eq!(got, n(&c["to_caller"]));
        }
    }
}
