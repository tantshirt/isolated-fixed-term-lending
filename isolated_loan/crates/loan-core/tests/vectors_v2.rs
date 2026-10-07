//! V2 parity vectors. Scenarios are defined here; their results are written to
//! `vectors-v2.json` with `REGENERATE_VECTORS=1 cargo test -p loan-core --test vectors_v2` and
//! checked on every other run. `tests/loan-math.test.ts` replays the same file in TypeScript.
use loan_core::accounting::*;
use serde_json::{json, Value};

const DAY: i64 = 86_400;
const START: i64 = 1_800_000_000;

fn terms(principal: u64, bps: u16, days: i64, policy: EarlyRepayment, ceiling: u16) -> TermsV2 {
    TermsV2 {
        principal,
        interest_bps: bps,
        duration: days * DAY,
        start_ts: START,
        early_repayment: policy,
        min_interest_bps: DEFAULT_MIN_INTEREST_BPS,
        grace_seconds: DEFAULT_GRACE_SECONDS,
        late_fee_bps: DEFAULT_LATE_FEE_BPS,
        annual_ceiling_bps: ceiling,
    }
}

enum Step {
    Payoff(i64),
    Pay(i64, u64),
    Phase(i64),
}

fn ledger_json(l: &Ledger) -> Value {
    json!({
        "outstanding_principal": l.outstanding_principal.to_string(),
        "interest_accrued": l.interest_accrued.to_string(),
        "interest_paid": l.interest_paid.to_string(),
        "accrual_remainder": l.accrual_remainder.to_string(),
        "last_accrual_ts": l.last_accrual_ts,
        "late_fee_assessed": l.late_fee_assessed.to_string(),
        "late_fee_paid": l.late_fee_paid.to_string(),
        "late_fee_checked": l.late_fee_checked,
    })
}

fn case(name: &str, t: TermsV2, steps: Vec<Step>) -> Value {
    let mut l = open(&t).unwrap();
    let mut out = vec![];
    for s in steps {
        out.push(match s {
            Step::Payoff(now) => json!({ "op": "payoff", "now": now, "expect": payoff(&t, &l, now).unwrap().to_string() }),
            Step::Phase(now) => json!({ "op": "phase", "now": now, "expect": format!("{:?}", phase(&t, now)) }),
            Step::Pay(now, amount) => {
                let (n, p) = apply_payment(&t, &l, now, amount).unwrap();
                l = n;
                json!({ "op": "pay", "now": now, "amount": amount.to_string(), "expect": {
                    "used": p.used.to_string(), "interest": p.interest.to_string(), "late_fee": p.late_fee.to_string(),
                    "principal": p.principal.to_string(), "adjustment": p.adjustment.to_string(), "closed": p.closed,
                    "ledger": ledger_json(&l),
                }})
            }
        });
    }
    json!({
        "name": name,
        "terms": {
            "principal": t.principal.to_string(), "interest_bps": t.interest_bps, "duration": t.duration, "start_ts": t.start_ts,
            "early_repayment": t.early_repayment as u8, "min_interest_bps": t.min_interest_bps, "grace_seconds": t.grace_seconds,
            "late_fee_bps": t.late_fee_bps, "annual_ceiling_bps": t.annual_ceiling_bps,
        },
        "derived": {
            "maturity": t.maturity(), "grace_end": t.grace_end(), "priced_recovery_from": t.priced_recovery_from(),
            "terminal_claim_from": t.terminal_claim_from(), "full_term_interest": t.full_term_interest().unwrap().to_string(),
            "charge_ceiling": t.charge_ceiling().unwrap().to_string(), "min_interest": t.min_interest().unwrap().to_string(),
            "max_exposure": t.max_exposure().unwrap().to_string(),
        },
        "steps": out,
    })
}

fn build() -> Value {
    let pr = terms(100_000_000, 500, 30, EarlyRepayment::ProRata, 10_000);
    let odd = terms(100_000_003, 777, 7, EarlyRepayment::ProRata, 60_000);
    let ft = terms(100_000_000, 500, 30, EarlyRepayment::FullTerm, 10_000);
    let tight = terms(100_000_000, 500, 30, EarlyRepayment::FullTerm, 5_900);
    let m = pr.maturity();
    let cases = vec![
        case("pro-rata, untouched, paid at maturity", pr, vec![Step::Payoff(m - 1), Step::Payoff(m), Step::Pay(m, u64::MAX)]),
        case("pro-rata, early payoff under the minimum", pr, vec![Step::Payoff(START + DAY), Step::Pay(START + DAY, u64::MAX)]),
        case("pro-rata, partials then late payoff", pr, vec![
            Step::Pay(START + 10 * DAY, 30_000_000),
            Step::Pay(START + 20 * DAY, 1),
            Step::Payoff(m),
            Step::Pay(m + 3_600, 2_000_000),
            Step::Pay(m + 7_200, u64::MAX),
        ]),
        case("odd principal, daily small payments", odd, (1..7).map(|d| Step::Pay(START + d * DAY, 13)).chain([Step::Pay(START + 7 * DAY - 1, u64::MAX)]).collect()),
        case("full-term, paid early", ft, vec![Step::Payoff(START + 1), Step::Pay(START + 1, u64::MAX)]),
        case("full-term, tight ceiling clamps the late fee", tight, vec![Step::Payoff(tight.maturity()), Step::Pay(tight.maturity() + 1, u64::MAX)]),
        case("phase boundaries", pr, vec![
            Step::Phase(m - 1), Step::Phase(m), Step::Phase(pr.grace_end() - 1), Step::Phase(pr.grace_end()),
            Step::Phase(pr.priced_recovery_from() - 1), Step::Phase(pr.priced_recovery_from()),
            Step::Phase(pr.terminal_claim_from() - 1), Step::Phase(pr.terminal_claim_from()),
        ]),
    ];
    let triggers: Vec<Value> = [(8_000u16, Some(8_000u16)), (8_200, Some(7_000)), (8_300, Some(7_000)), (8_299, None), (8_300, None), (7_999, Some(9_000))]
        .iter()
        .map(|(s, e)| json!({ "spot": s, "ema": e, "threshold": 8_000, "expect": liquidation_trigger(*s, *e, 8_000).map(|k| format!("{k:?}")) }))
        .collect();
    let splits: Vec<Value> = [(105_000_000u64, 1_001_001_002u64, 150_000_000u64), (105_000_000, 1_001_001_002, 90_000_000), (100, 1_000, 200)]
        .iter()
        .flat_map(|(p, l, v)| {
            let a = liquidation_split(*p, *l, *v).unwrap();
            let b = priced_recovery_split(*p, *l, *v).unwrap();
            [
                json!({ "kind": "liquidation", "payoff": p.to_string(), "lamports": l.to_string(), "value": v.to_string(), "to_recipient": a.to_recipient.to_string(), "to_borrower": a.to_borrower.to_string(), "shortfall": a.shortfall.to_string() }),
                json!({ "kind": "priced_recovery", "payoff": p.to_string(), "lamports": l.to_string(), "value": v.to_string(), "to_recipient": b.to_recipient.to_string(), "to_borrower": b.to_borrower.to_string(), "shortfall": b.shortfall.to_string() }),
            ]
        })
        .collect();
    json!({
        "note": "V2 accounting vectors (Story 20.1). Generated by crates/loan-core/tests/vectors_v2.rs and replayed by tests/loan-math.test.ts. Integers are strings so JavaScript keeps exact values.",
        "cases": cases, "triggers": triggers, "splits": splits,
    })
}

#[test]
fn vectors_v2_match() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors-v2.json");
    let built = build();
    if std::env::var("REGENERATE_VECTORS").is_ok() {
        std::fs::write(path, serde_json::to_string_pretty(&built).unwrap() + "\n").unwrap();
    }
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("run with REGENERATE_VECTORS=1 once")).unwrap();
    assert_eq!(stored, built, "vectors-v2.json is stale; regenerate it and review the diff");
}
