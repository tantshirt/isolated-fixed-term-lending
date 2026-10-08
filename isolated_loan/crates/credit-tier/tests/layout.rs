//! The `HistoryAttestation` byte layout read by `check_history` matches the real
//! `private_loan_v2` account (Story 27.1).

use anchor_lang::prelude::*;
use credit_tier::*;
use private_loan_v2::history::{HistoryAttestation, HISTORY_ATTESTATION_SEED as PL_SEED, HISTORY_ATTESTATION_VERSION as PL_VERSION};

#[test]
fn history_layout_matches_private_loan_v2() {
    assert_eq!(HistoryAttestation::DISCRIMINATOR, HISTORY_ATTESTATION_DISCRIMINATOR);
    assert_eq!(8 + HistoryAttestation::INIT_SPACE, HISTORY_ATTESTATION_LEN);
    assert_eq!(private_loan_v2::ID, PRIVATE_LOAN_V2_ID);
    assert_eq!(PL_SEED, HISTORY_ATTESTATION_SEED);
    assert_eq!(PL_VERSION, HISTORY_ATTESTATION_VERSION);
    let borrower = Pubkey::new_unique();
    let (key, bump) = Pubkey::find_program_address(&[HISTORY_ATTESTATION_SEED, borrower.as_ref()], &private_loan_v2::ID);
    let a = HistoryAttestation { version: 1, borrower, repaid: 7, on_time: 6, late: 1, liquidated: 2, defaulted: 3, loans_counted: 12, rollup_slot: 99, attested_at: 1_000, bump };
    let mut data = Vec::new();
    a.try_serialize(&mut data).unwrap();
    let c = check_history(&private_loan_v2::ID, &key, 1, &data, &borrower, 1_000).unwrap();
    assert_eq!((c.repaid, c.on_time, c.late, c.liquidated, c.defaulted, c.loans_counted, c.rollup_slot, c.attested_at), (7, 6, 1, 2, 3, 12, 99, 1_000));
}
