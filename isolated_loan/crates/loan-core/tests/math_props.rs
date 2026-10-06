//! Property tests for the shared loan math. Each property is a rounding or
//! bound rule from docs/research.md, checked across the whole input range.
//! Case count: PROPTEST_CASES (default 2000).

use loan_core::math::*;
use proptest::prelude::*;

fn cases() -> u32 {
    std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(2000)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(cases()))]

    /// Interest rounds up, never by more than one atom; nothing panics.
    #[test]
    fn interest_rounds_up_by_at_most_one(principal in any::<u64>(), bps in any::<u16>()) {
        let exact = principal as u128 * bps as u128;
        match interest(principal, bps) {
            Ok(i) => {
                prop_assert!(i as u128 * 10_000 >= exact);
                prop_assert!((i as u128) * 10_000 < exact + 10_000);
            }
            Err(_) => prop_assert!((exact + 9_999) / 10_000 > u64::MAX as u128),
        }
        if let Ok(d) = debt(principal, bps) {
            prop_assert!(d >= principal);
        }
    }

    /// Collateral value rounds down at price minus confidence; it never favours the borrower.
    #[test]
    fn collateral_value_rounds_down(lamports in any::<u64>(), price in 1i64..=i64::MAX, conf_frac in 0u64..10_000, exponent in -12i32..=-3) {
        let conf = ((price as u128 * conf_frac as u128) / 10_000) as u64;
        if let Ok(v) = collateral_value_usdc(lamports, price, conf, exponent) {
            let divisor = 10u128.pow((3 - exponent) as u32);
            let exact_num = lamports as u128 * (price as u128 - conf as u128);
            prop_assert!(v as u128 * divisor <= exact_num);
            prop_assert!((v as u128 + 1) * divisor > exact_num);
        }
    }

    /// Out-of-range prices and exponents always fail closed.
    #[test]
    fn bad_prices_fail_closed(lamports in any::<u64>(), price in i64::MIN..=0, conf in any::<u64>(), exponent in any::<i32>()) {
        prop_assert!(collateral_value_usdc(lamports, price, conf, -8).is_err());
        if !(-12..=-3).contains(&exponent) {
            prop_assert!(collateral_value_usdc(lamports, 1_000, 0, exponent).is_err());
        }
        if conf >= 1_000 {
            prop_assert!(collateral_value_usdc(lamports, 1_000, conf, -8).is_err());
        }
    }

    /// LTV rounds up and saturates, so an underwater loan always reads as liquidatable.
    #[test]
    fn ltv_rounds_up_and_saturates(debt in any::<u64>(), value in any::<u64>()) {
        let ltv = current_ltv_bps(debt, value).unwrap();
        if value == 0 {
            prop_assert_eq!(ltv, u16::MAX);
        } else {
            let exact_num = debt as u128 * 10_000;
            prop_assert!(ltv as u128 * value as u128 >= exact_num || ltv == u16::MAX);
        }
    }

    /// More collateral value never raises the LTV.
    #[test]
    fn ltv_is_monotonic_in_value(debt in any::<u64>(), a in any::<u64>(), b in any::<u64>()) {
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        prop_assert!(current_ltv_bps(debt, hi).unwrap() <= current_ltv_bps(debt, lo).unwrap());
    }

    /// The liquidator never takes more than the vault, and when the vault covers the
    /// seize amount it gets at least that much value.
    #[test]
    fn liquidation_split_is_bounded(lamports in any::<u64>(), debt in 0u64..=u64::MAX / 2, value in 1u64..=u64::MAX) {
        let seize = seize_usdc(debt).unwrap();
        prop_assert!(seize as u128 * 10_000 >= debt as u128 * 10_500);
        let to_caller = wsol_to_caller(lamports, seize, value).unwrap();
        prop_assert!(to_caller <= lamports);
        if to_caller < lamports {
            prop_assert!(to_caller as u128 * value as u128 >= lamports as u128 * seize as u128);
        }
    }

    /// Accepted terms always lie inside the caps.
    #[test]
    fn validated_terms_are_inside_caps(bps in any::<u16>(), duration in any::<i64>(), max_ltv in any::<u16>(), liq in any::<u16>()) {
        if validate_terms(bps, duration, max_ltv, liq).is_ok() {
            prop_assert!(bps <= 2_000);
            prop_assert!((60..=7_776_000).contains(&duration));
            prop_assert!(max_ltv <= 7_000);
            prop_assert!(liq >= max_ltv + 500 && liq <= 8_500);
        }
    }
}
