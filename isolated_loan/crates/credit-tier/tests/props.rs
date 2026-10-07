//! Property tests for the Story 27.1 tier rule and the attestation readers.

use anchor_lang::prelude::Pubkey;
use credit_tier::*;
use proptest::prelude::*;

fn inputs() -> impl Strategy<Value = TierInputs> {
    // Small counts hit every threshold; the occasional huge one checks overflow.
    let count = prop_oneof![9 => 0u32..12, 1 => any::<u32>()];
    (count.clone(), count.clone(), count.clone(), count, 0u8..=5)
        .prop_map(|(on_time, late, liquidated, defaulted, income_band)| TierInputs { on_time, late, liquidated, defaulted, income_band })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4096))]

    #[test]
    fn tier_is_in_range_and_capped_by_income(i in inputs()) {
        let t = tier(i);
        prop_assert!(t <= 3);
        prop_assert!(t <= i.income_band);
    }

    #[test]
    fn any_default_is_tier_zero(i in inputs(), d in 1u32..1000) {
        prop_assert_eq!(tier(TierInputs { defaulted: d, ..i }), 0);
    }

    #[test]
    fn more_on_time_never_lowers(i in inputs(), extra in 0u32..20) {
        let more = TierInputs { on_time: i.on_time.saturating_add(extra), ..i };
        prop_assert!(tier(more) >= tier(i));
    }

    #[test]
    fn more_slips_never_raise(i in inputs(), late in 0u32..5, liq in 0u32..5) {
        let worse = TierInputs { late: i.late.saturating_add(late), liquidated: i.liquidated.saturating_add(liq), ..i };
        prop_assert!(tier(worse) <= tier(i));
    }

    #[test]
    fn higher_band_never_lowers(i in inputs(), up in 0u8..3) {
        let richer = TierInputs { income_band: i.income_band.saturating_add(up), ..i };
        prop_assert!(tier(richer) >= tier(i));
    }

    #[test]
    fn history_round_trip(on_time in 0u32..1000, late in 0u32..1000, liquidated in any::<u32>(), defaulted in any::<u32>(),
                          loans in any::<u16>(), slot in 1u64..u64::MAX, age in 0i64..=MAX_ATTESTATION_AGE_SECONDS) {
        let borrower = Pubkey::new_unique();
        let now = 2_000_000_000i64;
        let (key, bump) = Pubkey::find_program_address(&[HISTORY_ATTESTATION_SEED, borrower.as_ref()], &PRIVATE_LOAN_V2_ID);
        let data = history_bytes(&borrower, on_time, late, liquidated, defaulted, loans, slot, now - age, bump);
        let c = check_history(&PRIVATE_LOAN_V2_ID, &key, 1, &data, &borrower, now).unwrap();
        prop_assert_eq!((c.on_time, c.late, c.liquidated, c.defaulted, c.loans_counted, c.rollup_slot), (on_time, late, liquidated, defaulted, loans, slot));
    }
}

#[allow(clippy::too_many_arguments)]
pub fn history_bytes(borrower: &Pubkey, on_time: u32, late: u32, liquidated: u32, defaulted: u32, loans: u16, slot: u64, attested_at: i64, bump: u8) -> Vec<u8> {
    let mut v = HISTORY_ATTESTATION_DISCRIMINATOR.to_vec();
    v.push(HISTORY_ATTESTATION_VERSION);
    v.extend_from_slice(borrower.as_ref());
    for n in [on_time + late, on_time, late, liquidated, defaulted] {
        v.extend_from_slice(&n.to_le_bytes());
    }
    v.extend_from_slice(&loans.to_le_bytes());
    v.extend_from_slice(&slot.to_le_bytes());
    v.extend_from_slice(&attested_at.to_le_bytes());
    v.push(bump);
    v
}

#[test]
fn history_rejections() {
    let borrower = Pubkey::new_unique();
    let now = 2_000_000_000i64;
    let (key, bump) = Pubkey::find_program_address(&[HISTORY_ATTESTATION_SEED, borrower.as_ref()], &PRIVATE_LOAN_V2_ID);
    let good = history_bytes(&borrower, 6, 0, 0, 0, 6, 42, now - 10, bump);
    let check = |owner: &Pubkey, key: &Pubkey, lamports: u64, data: &[u8], who: &Pubkey| check_history(owner, key, lamports, data, who, now);
    assert!(check(&PRIVATE_LOAN_V2_ID, &key, 1, &good, &borrower).is_ok());
    assert_eq!(check(&PRIVATE_LOAN_V2_ID, &key, 0, &good, &borrower), Err(HistoryError::Missing));
    assert_eq!(check(&PRIVATE_LOAN_V2_ID, &key, 1, &[], &borrower), Err(HistoryError::Missing));
    assert_eq!(check(&Pubkey::new_unique(), &key, 1, &good, &borrower), Err(HistoryError::WrongOwner));
    assert_eq!(check(&CREDIT_MXE_ID, &key, 1, &good, &borrower), Err(HistoryError::WrongOwner));
    assert_eq!(check(&PRIVATE_LOAN_V2_ID, &Pubkey::new_unique(), 1, &good, &borrower), Err(HistoryError::WrongAddress));
    // Another borrower's attestation offered for this borrower: wrong address.
    let other = Pubkey::new_unique();
    assert_eq!(check(&PRIVATE_LOAN_V2_ID, &key, 1, &good, &other), Err(HistoryError::WrongAddress));
    // The right address holding a record for someone else.
    let foreign = history_bytes(&other, 6, 0, 0, 0, 6, 42, now - 10, bump);
    assert_eq!(check(&PRIVATE_LOAN_V2_ID, &key, 1, &foreign, &borrower), Err(HistoryError::WrongBorrower));
    let mut bad = good.clone();
    bad[0] ^= 1;
    assert_eq!(check(&PRIVATE_LOAN_V2_ID, &key, 1, &bad, &borrower), Err(HistoryError::Malformed));
    let mut bad = good.clone();
    bad[8] = 2;
    assert_eq!(check(&PRIVATE_LOAN_V2_ID, &key, 1, &bad, &borrower), Err(HistoryError::Malformed));
    assert_eq!(check(&PRIVATE_LOAN_V2_ID, &key, 1, &good[..79], &borrower), Err(HistoryError::Malformed));
    let mut bad = good.clone();
    bad[41] = 9; // repaid != on_time + late
    assert_eq!(check(&PRIVATE_LOAN_V2_ID, &key, 1, &bad, &borrower), Err(HistoryError::Malformed));
    let empty = history_bytes(&borrower, 0, 0, 0, 0, 0, 0, 0, bump);
    assert_eq!(check(&PRIVATE_LOAN_V2_ID, &key, 1, &empty, &borrower), Err(HistoryError::NotAttested));
    let old = history_bytes(&borrower, 6, 0, 0, 0, 6, 42, now - MAX_ATTESTATION_AGE_SECONDS - 1, bump);
    assert_eq!(check(&PRIVATE_LOAN_V2_ID, &key, 1, &old, &borrower), Err(HistoryError::Stale));
    let future = history_bytes(&borrower, 6, 0, 0, 0, 6, 42, now + MAX_FUTURE_SKEW_SECONDS + 1, bump);
    assert_eq!(check(&PRIVATE_LOAN_V2_ID, &key, 1, &future, &borrower), Err(HistoryError::Stale));
}

pub fn tier_bytes(borrower: &Pubkey, tier: u8, computed_at: i64, attested_at: i64, income_valid_until: i64) -> Vec<u8> {
    let mut v = vec![0u8; TIER_RESULT_LEN];
    v[..8].copy_from_slice(&TIER_RESULT_DISCRIMINATOR);
    v[tier_offsets::VERSION] = TIER_RESULT_VERSION;
    v[tier_offsets::BORROWER..tier_offsets::BORROWER + 32].copy_from_slice(borrower.as_ref());
    v[tier_offsets::TIER] = tier;
    v[tier_offsets::COMPUTED_SLOT..tier_offsets::COMPUTED_SLOT + 8].copy_from_slice(&7u64.to_le_bytes());
    v[tier_offsets::COMPUTED_AT..tier_offsets::COMPUTED_AT + 8].copy_from_slice(&computed_at.to_le_bytes());
    v[tier_offsets::ATTESTATION_SLOT..tier_offsets::ATTESTATION_SLOT + 8].copy_from_slice(&42u64.to_le_bytes());
    v[tier_offsets::ATTESTED_AT..tier_offsets::ATTESTED_AT + 8].copy_from_slice(&attested_at.to_le_bytes());
    v[tier_offsets::INCOME_VALID_UNTIL..tier_offsets::INCOME_VALID_UNTIL + 8].copy_from_slice(&income_valid_until.to_le_bytes());
    v
}

#[test]
fn tier_result_rejections() {
    let borrower = Pubkey::new_unique();
    let now = 2_000_000_000i64;
    let (key, _) = Pubkey::find_program_address(&[TIER_RESULT_SEED, borrower.as_ref()], &CREDIT_MXE_ID);
    let good = tier_bytes(&borrower, 3, now - 5, now - 10, now + 100);
    let read = |owner: &Pubkey, key: &Pubkey, data: &[u8], who: &Pubkey| read_tier_result(owner, key, 1, data, who, now);
    assert_eq!(read(&CREDIT_MXE_ID, &key, &good, &borrower), 3);
    assert_eq!(read_tier_result(&CREDIT_MXE_ID, &key, 0, &good, &borrower, now), 0);
    assert_eq!(read(&Pubkey::new_unique(), &key, &good, &borrower), 0, "forged: wrong owner");
    assert_eq!(read(&PRIVATE_LOAN_V2_ID, &key, &good, &borrower), 0);
    assert_eq!(read(&CREDIT_MXE_ID, &Pubkey::new_unique(), &good, &borrower), 0, "wrong address");
    assert_eq!(read(&CREDIT_MXE_ID, &key, &good, &Pubkey::new_unique()), 0, "another borrower");
    assert_eq!(read(&CREDIT_MXE_ID, &key, &tier_bytes(&Pubkey::new_unique(), 3, now - 5, now - 10, now + 100), &borrower), 0);
    assert_eq!(read(&CREDIT_MXE_ID, &key, &tier_bytes(&borrower, 3, 0, now - 10, now + 100), &borrower), 0, "never computed");
    assert_eq!(read(&CREDIT_MXE_ID, &key, &tier_bytes(&borrower, 3, now - 5, now - MAX_ATTESTATION_AGE_SECONDS - 1, now + 100), &borrower), 0, "stale");
    assert_eq!(read(&CREDIT_MXE_ID, &key, &tier_bytes(&borrower, 3, now - 5, now - 10, now), &borrower), 0, "income expired");
    assert_eq!(read(&CREDIT_MXE_ID, &key, &tier_bytes(&borrower, 4, now - 5, now - 10, now + 100), &borrower), 0);
    assert_eq!(read(&CREDIT_MXE_ID, &key, &tier_bytes(&borrower, 0, now - 5, now - 10, now + 100), &borrower), 0);
    let mut bad = good.clone();
    bad[0] ^= 1;
    assert_eq!(read(&CREDIT_MXE_ID, &key, &bad, &borrower), 0);
    assert_eq!(read(&CREDIT_MXE_ID, &key, &good[..TIER_RESULT_LEN - 1], &borrower), 0);
}
