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
