//! Property tests for V2 accounting (Story 20.1): cap precedence, remainder bounds, payment order,
//! conservation, and equality with V1 debt when nothing is paid early.
use loan_core::accounting::*;
use proptest::prelude::*;

fn cases() -> u32 {
    std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(2000)
}

const DAY: i64 = 86_400;
const START: i64 = 1_800_000_000;

fn terms() -> impl Strategy<Value = TermsV2> {
    (
        1_000u64..1_000_000_000_000,
        0u16..=2_000,
        60i64..=90 * DAY,
        any::<bool>(),
        0u16..=10_000,
        MIN_GRACE_SECONDS..=MAX_GRACE_SECONDS,
        0u16..=MAX_LATE_FEE_BPS,
        1u16..=PROTOCOL_MAX_ANNUAL_CEILING_BPS,
    )
        .prop_map(|(principal, interest_bps, duration, pro, min_interest_bps, grace_seconds, late_fee_bps, annual_ceiling_bps)| TermsV2 {
            principal,
            interest_bps,
            duration,
            start_ts: START,
            early_repayment: if pro { EarlyRepayment::ProRata } else { EarlyRepayment::FullTerm },
            min_interest_bps,
            grace_seconds,
            late_fee_bps,
            annual_ceiling_bps,
        })
        .prop_filter("terms must validate", |t| t.validate().is_ok())
}

/// A list of (seconds after the previous step, payment amount) pairs.
fn payments() -> impl Strategy<Value = Vec<(i64, u64)>> {
    prop::collection::vec((0i64..20 * DAY, 1u64..2_000_000_000_000), 0..12)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(cases()))]

    #[test]
    fn charges_never_exceed_the_ceiling_and_tokens_are_conserved(t in terms(), ps in payments()) {
        let ceiling = t.charge_ceiling().unwrap();
        let mut l = open(&t).unwrap();
        let mut now = t.start_ts;
        let mut paid: u128 = 0;
        let mut closed = false;
        for (dt, amount) in ps {
            now += dt;
            let before = payoff(&t, &l, now).unwrap();
            let (n, p) = apply_payment(&t, &l, now, amount).unwrap();
            prop_assert!(p.used <= amount);
            prop_assert!(p.used <= before);
            prop_assert_eq!(p.used, p.interest + p.late_fee + p.principal + p.adjustment);
            // Order: principal is touched only after accrued interest and late fees are cleared.
            if p.principal > 0 && !p.closed {
                prop_assert_eq!(n.interest_accrued, 0);
                prop_assert_eq!(n.late_fee_assessed, n.late_fee_paid);
            }
            prop_assert!(n.accrual_remainder < 10_000u128 * t.duration as u128);
            prop_assert!(n.interest_paid + n.interest_accrued + n.late_fee_assessed <= ceiling);
            paid += p.used as u128;
            l = n;
            if p.closed { closed = true; break; }
        }
        if !closed {
            let (n, p) = apply_payment(&t, &l, now, u64::MAX).unwrap();
            prop_assert!(p.closed);
            paid += p.used as u128;
            l = n;
        }
        // Everything the borrower paid is principal plus charges, and charges stay under the ceiling.
        prop_assert_eq!(paid, t.principal as u128 + l.interest_paid as u128 + l.late_fee_paid as u128);
        prop_assert!(l.interest_paid + l.late_fee_paid <= ceiling);
        prop_assert_eq!(l.outstanding_principal, 0);
    }

    #[test]
    fn untouched_loans_owe_v1_debt_at_maturity_before_fees(t in terms()) {
        let l = open(&t).unwrap();
        let at = t.maturity() - 1;
        let synced = sync(&t, &l, t.maturity()).unwrap();
        let v1 = loan_core::math::debt(t.principal, t.interest_bps).unwrap();
        prop_assert_eq!(payoff(&t, &l, t.maturity()).unwrap(), v1 + synced.late_fee_assessed);
        // Before maturity no late fee exists and nothing above V1 debt is owed.
        prop_assert!(payoff(&t, &l, at).unwrap() <= v1.max(t.principal + t.min_interest().unwrap()));
    }

    #[test]
    fn the_minimum_interest_is_paid_once_at_final_payoff(t in terms(), dt in 0i64..90 * DAY) {
        let l = open(&t).unwrap();
        let now = t.start_ts + dt.min(t.duration - 1);
        let (l, p) = apply_payment(&t, &l, now, u64::MAX).unwrap();
        prop_assert!(p.closed);
        prop_assert!(l.interest_paid >= t.min_interest().unwrap());
        prop_assert!(l.interest_paid <= t.full_term_interest().unwrap());
    }

    #[test]
    fn phases_are_ordered(t in terms(), now in START..START + 200 * DAY) {
        let order = |p: Phase| match p { Phase::Active => 0, Phase::Grace => 1, Phase::Overdue => 2, Phase::PricedRecovery => 3, Phase::Terminal => 4 };
        prop_assert!(order(phase(&t, now)) <= order(phase(&t, now + 1)));
    }
}
