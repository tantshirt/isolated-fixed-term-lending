use crate::constants::{MAX_CONF_BPS_OF_PRICE, MAX_PRICE_AGE_SECONDS, PYTH_RECEIVER_PROGRAM_ID, SOL_USD_FEED_ID};
use crate::error::LoanError;
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

pub struct OraclePrice {
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
}

pub fn read_sol_usd_price(
    price_update_account: &AccountInfo,
    clock: &Clock,
) -> Result<OraclePrice> {
    require_keys_eq!(
        *price_update_account.owner,
        PYTH_RECEIVER_PROGRAM_ID,
        LoanError::InvalidPriceOwner
    );

    let price_update =
        PriceUpdateV2::try_deserialize(&mut &price_update_account.data.borrow()[..])
            .map_err(|_| error!(LoanError::InvalidPrice))?;

    let feed_id = price_update.price_message.feed_id;
    require!(feed_id == SOL_USD_FEED_ID, LoanError::InvalidFeedId);

    let price = price_update
        .get_price_no_older_than(clock, MAX_PRICE_AGE_SECONDS, &SOL_USD_FEED_ID)
        .map_err(|_| error!(LoanError::StalePrice))?;

    require!(price.price > 0, LoanError::InvalidPrice);
    require!(price.conf < price.price as u64, LoanError::InvalidPrice);

    let conf_bps = (price.conf as u128)
        .checked_mul(10_000)
        .ok_or(LoanError::MathOverflow)?;
    require!(
        conf_bps <= (price.price as u128) * MAX_CONF_BPS_OF_PRICE,
        LoanError::InvalidPrice
    );

    require!(
        price.exponent >= crate::constants::MIN_EXPONENT
            && price.exponent <= crate::constants::MAX_EXPONENT,
        LoanError::InvalidExponent
    );

    Ok(OraclePrice {
        price: price.price,
        conf: price.conf,
        exponent: price.exponent,
    })
}
