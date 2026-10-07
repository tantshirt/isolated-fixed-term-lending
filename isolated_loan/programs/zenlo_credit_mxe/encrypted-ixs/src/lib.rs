//! Story 27.1: the credit tier circuit (research.md § Arcium credit tier).
//!
//! `tier` takes the counts that `zenlo_credit_mxe` read from the borrower's rollup-signed
//! `HistoryAttestation` and the income band from their SAS credential, and returns only the tier.
//! `tier_rule` is the same rule as `credit_tier::tier`; the tests below compare them on every
//! threshold and on random inputs.

use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// The tier rule. Written without early returns (Arcis has none): every branch is evaluated
    /// and the result selected.
    pub fn tier_rule(on_time: u32, late: u32, liquidated: u32, defaulted: u32, income_band: u8) -> u8 {
        let slips = late as u64 + liquidated as u64;
        let eligible = defaulted == 0 && income_band > 0;
        let t3 = on_time >= 6 && slips == 0 && income_band >= 3;
        let t2 = on_time >= 3 && late <= 1 && liquidated == 0 && income_band >= 2;
        let t1 = on_time >= 1 && slips <= 1;
        if !eligible {
            0
        } else if t3 {
            3
        } else if t2 {
            2
        } else if t1 {
            1
        } else {
            0
        }
    }

    /// Entry point. Reveals only the tier.
    #[instruction]
    pub fn tier(on_time: u32, late: u32, liquidated: u32, defaulted: u32, income_band: u8) -> u8 {
        tier_rule(on_time, late, liquidated, defaulted, income_band)
    }
}

#[cfg(test)]
mod tests {
    use super::circuits::tier_rule;
    use credit_tier::{tier, TierInputs};
    use proptest::prelude::*;

    fn same(on_time: u32, late: u32, liquidated: u32, defaulted: u32, income_band: u8) {
        let reference = tier(TierInputs { on_time, late, liquidated, defaulted, income_band });
        assert_eq!(tier_rule(on_time, late, liquidated, defaulted, income_band), reference, "({on_time}, {late}, {liquidated}, {defaulted}, {income_band})");
    }

    #[test]
    fn agrees_on_every_threshold() {
        let counts = [0u32, 1, 2, 3, 5, 6, 7, 100, u32::MAX];
        for on_time in counts {
            for late in counts {
                for liquidated in counts {
                    for defaulted in [0u32, 1, u32::MAX] {
                        for band in 0u8..=4 {
                            same(on_time, late, liquidated, defaulted, band);
                        }
                    }
                }
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(4096))]
        #[test]
        fn agrees_on_random_inputs(on_time in any::<u32>(), late in 0u32..4, liquidated in 0u32..4, defaulted in 0u32..3, band in any::<u8>()) {
            same(on_time % 10, late, liquidated, defaulted, band);
            same(on_time, late, liquidated, defaulted, band);
        }
    }
}
