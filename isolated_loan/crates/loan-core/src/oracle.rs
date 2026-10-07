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

// Story 26.2. Per-asset reads are added below the SOL/USD functions, which are left exactly as
// they were: the legacy programs link them, panic locations carry line numbers, and keeping
// both untouched keeps the legacy programs' bytes identical. `sol_path_matches_read_price`
// proves the SOL/USD read and the generic read agree.

/// Reads any configured feed with every check the SOL/USD read applies: receiver owner, the
/// expected feed id, Full verification and age through `get_price_no_older_than`, the
/// confidence band and the exponent range. Only the feed id varies.
pub fn read_price(price_update_account: &AccountInfo, clock: &Clock, feed_id: &[u8; 32]) -> CoreResult<OraclePrice> {
    if *price_update_account.owner != PYTH_RECEIVER_PROGRAM_ID {
        return Err(CoreError::InvalidPriceOwner);
    }
    let price_update = PriceUpdateV2::try_deserialize(&mut &price_update_account.data.borrow()[..])
        .map_err(|_| CoreError::InvalidPrice)?;
    if price_update.price_message.feed_id != *feed_id {
        return Err(CoreError::InvalidFeedId);
    }
    let price = price_update
        .get_price_no_older_than(clock, MAX_PRICE_AGE_SECONDS, feed_id)
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
    Ok(OraclePrice { price: price.price, conf: price.conf, exponent: price.exponent })
}

/// `read_sol_usd_spot_and_ema` for any configured feed: the spot must pass `read_price`, and the
/// EMA from the same verified message is judged on its own confidence (`None` if it fails).
pub fn read_spot_and_ema(price_update_account: &AccountInfo, clock: &Clock, feed_id: &[u8; 32]) -> CoreResult<(OraclePrice, Option<OraclePrice>)> {
    let spot = read_price(price_update_account, clock, feed_id)?;
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

#[cfg(test)]
mod feed_tests {
    use super::*;
    use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, VerificationLevel};

    const NOW: i64 = 1_800_000_000;

    fn update(feed_id: [u8; 32], publish_time: i64, level: VerificationLevel) -> Vec<u8> {
        let u = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: level,
            price_message: PriceFeedMessage {
                feed_id,
                price: 16_000_000_000,
                conf: 16_000_000,
                exponent: -8,
                publish_time,
                prev_publish_time: publish_time - 1,
                ema_price: 15_900_000_000,
                ema_conf: 15_900_000,
            },
            posted_slot: 1,
        };
        let mut data = Vec::new();
        u.try_serialize(&mut data).unwrap();
        data
    }

    fn clock() -> Clock {
        Clock { unix_timestamp: NOW, ..Clock::default() }
    }

    fn read(owner: Pubkey, data: &mut [u8], feed: &[u8; 32]) -> CoreResult<OraclePrice> {
        let key = Pubkey::new_unique();
        let mut lamports = 1_u64;
        let info = AccountInfo::new(&key, false, false, &mut lamports, data, &owner, false);
        read_price(&info, &clock(), feed)
    }

    fn err(r: CoreResult<OraclePrice>) -> Option<CoreError> {
        r.err()
    }

    #[test]
    fn configured_feed_reads_with_every_check() {
        let mut data = update(JITOSOL_USD_FEED_ID, NOW, VerificationLevel::Full);
        let p = read(PYTH_RECEIVER_PROGRAM_ID, &mut data, &JITOSOL_USD_FEED_ID).unwrap();
        assert_eq!((p.price, p.conf, p.exponent), (16_000_000_000, 16_000_000, -8));
    }

    #[test]
    fn foreign_owner_is_rejected() {
        let mut data = update(JITOSOL_USD_FEED_ID, NOW, VerificationLevel::Full);
        assert_eq!(err(read(Pubkey::new_unique(), &mut data, &JITOSOL_USD_FEED_ID)), Some(CoreError::InvalidPriceOwner));
    }

    #[test]
    fn wrong_feed_is_rejected() {
        // A real SOL/USD update cannot price jitoSOL, and the reverse.
        let mut data = update(SOL_USD_FEED_ID, NOW, VerificationLevel::Full);
        assert_eq!(err(read(PYTH_RECEIVER_PROGRAM_ID, &mut data, &JITOSOL_USD_FEED_ID)), Some(CoreError::InvalidFeedId));
        let mut data = update(JITOSOL_USD_FEED_ID, NOW, VerificationLevel::Full);
        assert_eq!(err(read(PYTH_RECEIVER_PROGRAM_ID, &mut data, &SOL_USD_FEED_ID)), Some(CoreError::InvalidFeedId));
    }

    #[test]
    fn stale_or_partially_verified_price_is_rejected() {
        let age = MAX_PRICE_AGE_SECONDS as i64;
        let mut data = update(JITOSOL_USD_FEED_ID, NOW - age - 1, VerificationLevel::Full);
        assert_eq!(err(read(PYTH_RECEIVER_PROGRAM_ID, &mut data, &JITOSOL_USD_FEED_ID)), Some(CoreError::StalePrice));
        let mut data = update(JITOSOL_USD_FEED_ID, NOW - age, VerificationLevel::Full);
        assert!(read(PYTH_RECEIVER_PROGRAM_ID, &mut data, &JITOSOL_USD_FEED_ID).is_ok());
        let mut data = update(JITOSOL_USD_FEED_ID, NOW, VerificationLevel::Partial { num_signatures: 5 });
        assert_eq!(err(read(PYTH_RECEIVER_PROGRAM_ID, &mut data, &JITOSOL_USD_FEED_ID)), Some(CoreError::StalePrice));
    }

    #[test]
    fn spot_and_ema_use_the_given_feed() {
        let key = Pubkey::new_unique();
        let owner = PYTH_RECEIVER_PROGRAM_ID;
        let mut lamports = 1_u64;
        let mut data = update(JITOSOL_USD_FEED_ID, NOW, VerificationLevel::Full);
        let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
        let (spot, ema) = read_spot_and_ema(&info, &clock(), &JITOSOL_USD_FEED_ID).unwrap();
        assert_eq!(spot.price, 16_000_000_000);
        assert_eq!(ema.unwrap().price, 15_900_000_000);
        assert_eq!(read_sol_usd_spot_and_ema(&info, &clock()).err(), Some(CoreError::InvalidFeedId));
    }

    /// The untouched SOL/USD read and the generic read at the SOL/USD feed agree on every
    /// outcome: owner, feed, age, verification, band and exponent.
    #[test]
    fn sol_path_matches_read_price() {
        let receiver = PYTH_RECEIVER_PROGRAM_ID;
        let flat = |r: CoreResult<OraclePrice>| r.map(|p| (p.price, p.conf, p.exponent));
        let mut cases: Vec<(Pubkey, Vec<u8>)> = vec![
            (receiver, update(SOL_USD_FEED_ID, NOW, VerificationLevel::Full)),
            (receiver, update(SOL_USD_FEED_ID, NOW - 60, VerificationLevel::Full)),
            (receiver, update(SOL_USD_FEED_ID, NOW - 61, VerificationLevel::Full)),
            (receiver, update(SOL_USD_FEED_ID, NOW, VerificationLevel::Partial { num_signatures: 3 })),
            (receiver, update(JITOSOL_USD_FEED_ID, NOW, VerificationLevel::Full)),
            (Pubkey::new_unique(), update(SOL_USD_FEED_ID, NOW, VerificationLevel::Full)),
            (receiver, vec![0u8; 40]),
        ];
        for (price, conf, exponent) in [(0_i64, 0_u64, -8), (100, 100, -8), (10_000, 201, -8), (10_000, 200, -8), (10_000, 1, -2), (10_000, 1, -13)] {
            let mut d = update(SOL_USD_FEED_ID, NOW, VerificationLevel::Full);
            let mut u = PriceUpdateV2::try_deserialize(&mut &d[..]).unwrap();
            u.price_message.price = price;
            u.price_message.conf = conf;
            u.price_message.exponent = exponent;
            d.clear();
            u.try_serialize(&mut d).unwrap();
            cases.push((receiver, d));
        }
        for (owner, mut data) in cases {
            let key = Pubkey::new_unique();
            let mut lamports = 1_u64;
            let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
            assert_eq!(flat(read_sol_usd_price(&info, &clock())), flat(read_price(&info, &clock(), &SOL_USD_FEED_ID)));
        }
    }
}
