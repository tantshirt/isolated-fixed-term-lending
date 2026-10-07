use crate::constants::*;
use crate::{CoreError, CoreResult};
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

pub struct OraclePrice {
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
}

/// Checks that an account is a canonical Pyth Receiver SOL/USD update without
/// checking its age. Used where an account is stored for later reads.
pub fn check_sol_usd_account(price_update_account: &AccountInfo) -> CoreResult<()> {
    if *price_update_account.owner != PYTH_RECEIVER_PROGRAM_ID {
        return Err(CoreError::InvalidPriceOwner);
    }
    let price_update = PriceUpdateV2::try_deserialize(&mut &price_update_account.data.borrow()[..])
        .map_err(|_| CoreError::InvalidPrice)?;
    if price_update.price_message.feed_id != SOL_USD_FEED_ID {
        return Err(CoreError::InvalidFeedId);
    }
    Ok(())
}

/// Reads SOL/USD from a canonical Pyth Receiver `PriceUpdateV2` account.
/// The owner check is not optional: an account owned by any other program,
/// including a price feed with a compatible layout, fails closed.
pub fn read_sol_usd_price(price_update_account: &AccountInfo, clock: &Clock) -> CoreResult<OraclePrice> {
    if *price_update_account.owner != PYTH_RECEIVER_PROGRAM_ID {
        return Err(CoreError::InvalidPriceOwner);
    }

    let price_update = PriceUpdateV2::try_deserialize(&mut &price_update_account.data.borrow()[..])
        .map_err(|_| CoreError::InvalidPrice)?;

    if price_update.price_message.feed_id != SOL_USD_FEED_ID {
        return Err(CoreError::InvalidFeedId);
    }

    let price = price_update
        .get_price_no_older_than(clock, MAX_PRICE_AGE_SECONDS, &SOL_USD_FEED_ID)
        .map_err(|_| CoreError::StalePrice)?;

    if price.price <= 0 || price.conf >= price.price as u64 {
        return Err(CoreError::InvalidPrice);
    }

    let conf_bps = (price.conf as u128)
        .checked_mul(10_000)
        .ok_or(CoreError::MathOverflow)?;
    if conf_bps > (price.price as u128) * MAX_CONF_BPS_OF_PRICE {
        return Err(CoreError::InvalidPrice);
    }

    if price.exponent < MIN_EXPONENT || price.exponent > MAX_EXPONENT {
        return Err(CoreError::InvalidExponent);
    }

    Ok(OraclePrice {
        price: price.price,
        conf: price.conf,
        exponent: price.exponent,
    })
}

/// Same band checks the spot price must pass, applied to any price and its own confidence.
fn band_ok(price: i64, conf: u64, exponent: i32) -> bool {
    price > 0
        && conf < price as u64
        && (conf as u128) * 10_000 <= (price as u128) * MAX_CONF_BPS_OF_PRICE
        && (MIN_EXPONENT..=MAX_EXPONENT).contains(&exponent)
}

/// Spot plus EMA for V2 liquidation (Story 20.3). The spot must pass every V1 check or this
/// fails. The EMA comes from the same verified, fresh message and is judged on its own
/// confidence; if it fails its checks it is `None`, so only an emergency liquidation can qualify.
pub fn read_sol_usd_spot_and_ema(price_update_account: &AccountInfo, clock: &Clock) -> CoreResult<(OraclePrice, Option<OraclePrice>)> {
    let spot = read_sol_usd_price(price_update_account, clock)?;
    let price_update = PriceUpdateV2::try_deserialize(&mut &price_update_account.data.borrow()[..])
        .map_err(|_| CoreError::InvalidPrice)?;
    let m = &price_update.price_message;
    let ema = band_ok(m.ema_price, m.ema_conf, m.exponent).then_some(OraclePrice { price: m.ema_price, conf: m.ema_conf, exponent: m.exponent });
    Ok((spot, ema))
}

#[cfg(test)]
mod band_tests {
    use super::band_ok;

    #[test]
    fn ema_band_uses_its_own_confidence() {
        assert!(band_ok(15_000_000_000, 15_000_000, -8));
        assert!(band_ok(15_000_000_000, 300_000_000, -8));
        assert!(!band_ok(15_000_000_000, 300_000_001, -8));
        assert!(!band_ok(0, 0, -8));
        assert!(!band_ok(15_000_000_000, 0, -2));
    }
}
