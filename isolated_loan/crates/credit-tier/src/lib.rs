//! Story 27.1: the credit tier computed by Arcium (research.md § Arcium credit tier).
//!
//! Three things live here so the MXE program, the public V2 program and the circuit tests share
//! one definition:
//!
//! 1. [`tier`], the plaintext reference rule. The Arcis circuit in `encrypted-ixs` implements the
//!    same rule and its tests compare the two on every input class.
//! 2. [`check_history`], which reads a `private_loan_v2` `HistoryAttestation` from raw account
//!    bytes and refuses anything not written by that program for that borrower, or too old.
//! 3. [`read_tier_result`], which reads a `zenlo_credit_mxe` `TierResult` the same way for
//!    `isolated_loan_v2`.
//!
//! Byte layouts are copied from the Anchor structs and checked against them in the programs' tests
//! (`zenlo_credit_mxe` checks both discriminators and the attestation layout).

use anchor_lang::prelude::Pubkey;
use anchor_lang::pubkey;

/// `private_loan_v2`, the only program whose `HistoryAttestation` the MXE accepts.
pub const PRIVATE_LOAN_V2_ID: Pubkey = pubkey!("JAzy8NP6V8AGrAko8vfgrD44BDghN6eLwqB7vjuYhHNq");
/// `zenlo_credit_mxe`, the only program whose `TierResult` `isolated_loan_v2` accepts.
pub const CREDIT_MXE_ID: Pubkey = pubkey!("828JKMx1RDffwUtWAKQ7gwyFwWEBrxoWQ5UnnJ9Upreb");

pub const HISTORY_ATTESTATION_SEED: &[u8] = b"credit-attestation";
pub const HISTORY_ATTESTATION_VERSION: u8 = 1;
pub const TIER_RESULT_SEED: &[u8] = b"arcium-tier";
pub const TIER_RESULT_VERSION: u8 = 1;

/// An attestation older than this (by its rollup `attested_at`) is stale: 30 days. The same bound
/// applies to a `TierResult`, measured from the attestation it was computed from.
pub const MAX_ATTESTATION_AGE_SECONDS: i64 = 30 * 86_400;
/// Rollup and base-layer clocks can differ a little; an attestation dated further ahead than this
/// is refused.
pub const MAX_FUTURE_SKEW_SECONDS: i64 = 300;

/// The inputs of the tier rule. The counts come only from a `HistoryAttestation`; the income band
/// only from the borrower's SAS credit credential (band = credential tier, `app/lib/credit/bands.ts`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TierInputs {
    pub on_time: u32,
    pub late: u32,
    pub liquidated: u32,
    pub defaulted: u32,
    /// 0 none or below $2,000 a month, 1 entry, 2 middle, 3 upper.
    pub income_band: u8,
}

/// The tier rule (research.md § Arcium credit tier). Fails closed: any default, or no income band,
/// is tier 0.
///
/// | Tier | On time | Late | Risk liquidations | Defaults | Income band |
/// | ---- | ------- | ---- | ----------------- | -------- | ----------- |
/// | 3    | ≥ 6     | 0    | 0                 | 0        | ≥ 3         |
/// | 2    | ≥ 3     | ≤ 1  | 0                 | 0        | ≥ 2         |
/// | 1    | ≥ 1     | late + liquidated ≤ 1 |    | 0        | ≥ 1         |
/// | 0    | anything else                                            |
pub fn tier(i: TierInputs) -> u8 {
    if i.defaulted > 0 || i.income_band == 0 {
        return 0;
    }
    let slips = i.late as u64 + i.liquidated as u64;
    if i.on_time >= 6 && slips == 0 && i.income_band >= 3 {
        3
    } else if i.on_time >= 3 && i.late <= 1 && i.liquidated == 0 && i.income_band >= 2 {
        2
    } else if i.on_time >= 1 && slips <= 1 {
        1
    } else {
        0
    }
}

/// `sha256("account:HistoryAttestation")[..8]`.
pub const HISTORY_ATTESTATION_DISCRIMINATOR: [u8; 8] = [181, 148, 111, 79, 135, 53, 102, 106];
/// 8 + `HistoryAttestation::INIT_SPACE` (72).
pub const HISTORY_ATTESTATION_LEN: usize = 80;

/// The counts of a valid attestation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HistoryCounts {
    pub repaid: u32,
    pub on_time: u32,
    pub late: u32,
    pub liquidated: u32,
    pub defaulted: u32,
    pub loans_counted: u16,
    pub rollup_slot: u64,
    pub attested_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryError {
    /// No account, or no lamports.
    Missing,
    /// Not owned by `private_loan_v2`.
    WrongOwner,
    /// Not at `["credit-attestation", borrower]` of `private_loan_v2`.
    WrongAddress,
    /// Wrong discriminator, length, version or counts that do not add up.
    Malformed,
    /// The attestation names another borrower.
    WrongBorrower,
    /// Opened but never written by the rollup (`rollup_slot` 0).
    NotAttested,
    /// Older than [`MAX_ATTESTATION_AGE_SECONDS`] or dated in the future.
    Stale,
}

fn u32_at(d: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(d[at..at + 4].try_into().unwrap())
}
fn u64_at(d: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}
fn i64_at(d: &[u8], at: usize) -> i64 {
    i64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}
fn key_at(d: &[u8], at: usize) -> Pubkey {
    Pubkey::new_from_array(d[at..at + 32].try_into().unwrap())
}

/// Whether `attested_at` is fresh at `now`.
pub fn fresh(attested_at: i64, now: i64) -> bool {
    attested_at > 0 && attested_at <= now.saturating_add(MAX_FUTURE_SKEW_SECONDS) && now.saturating_sub(attested_at) <= MAX_ATTESTATION_AGE_SECONDS
}

/// Reads a `HistoryAttestation` and accepts it only when `private_loan_v2` wrote it for
/// `borrower` and it is fresh. Layout (Anchor, `programs/private_loan_v2/src/history.rs`):
///
/// ```text
/// [0..8]   discriminator   [8] version u8   [9..41] borrower
/// [41..45] repaid u32      [45..49] on_time  [49..53] late  [53..57] liquidated  [57..61] defaulted
/// [61..63] loans_counted u16   [63..71] rollup_slot u64   [71..79] attested_at i64   [79] bump
/// ```
pub fn check_history(owner: &Pubkey, key: &Pubkey, lamports: u64, data: &[u8], borrower: &Pubkey, now: i64) -> Result<HistoryCounts, HistoryError> {
    if lamports == 0 || data.is_empty() {
        return Err(HistoryError::Missing);
    }
    if *owner != PRIVATE_LOAN_V2_ID {
        return Err(HistoryError::WrongOwner);
    }
    let (expected, _) = Pubkey::find_program_address(&[HISTORY_ATTESTATION_SEED, borrower.as_ref()], &PRIVATE_LOAN_V2_ID);
    if *key != expected {
        return Err(HistoryError::WrongAddress);
    }
    if data.len() < HISTORY_ATTESTATION_LEN || data[..8] != HISTORY_ATTESTATION_DISCRIMINATOR || data[8] != HISTORY_ATTESTATION_VERSION {
        return Err(HistoryError::Malformed);
    }
    if key_at(data, 9) != *borrower {
        return Err(HistoryError::WrongBorrower);
    }
    let c = HistoryCounts {
        repaid: u32_at(data, 41),
        on_time: u32_at(data, 45),
        late: u32_at(data, 49),
        liquidated: u32_at(data, 53),
        defaulted: u32_at(data, 57),
        loans_counted: u16::from_le_bytes(data[61..63].try_into().unwrap()),
        rollup_slot: u64_at(data, 63),
        attested_at: i64_at(data, 71),
    };
    if c.rollup_slot == 0 {
        return Err(HistoryError::NotAttested);
    }
    if c.repaid as u64 != c.on_time as u64 + c.late as u64 {
        return Err(HistoryError::Malformed);
    }
    if !fresh(c.attested_at, now) {
        return Err(HistoryError::Stale);
    }
    Ok(c)
}

/// `sha256("account:TierResult")[..8]`.
pub const TIER_RESULT_DISCRIMINATOR: [u8; 8] = [184, 145, 6, 108, 238, 82, 35, 33];
/// 8 + `TierResult::INIT_SPACE` (140).
pub const TIER_RESULT_LEN: usize = 148;
/// Offsets inside a `TierResult` account (`programs/zenlo_credit_mxe/src/lib.rs`).
pub mod tier_offsets {
    pub const VERSION: usize = 8;
    pub const BORROWER: usize = 9;
    pub const TIER: usize = 41;
    pub const COMPUTED_SLOT: usize = 42;
    pub const COMPUTED_AT: usize = 50;
    pub const ATTESTATION_SLOT: usize = 58;
    pub const ATTESTED_AT: usize = 66;
    pub const INCOME_VALID_UNTIL: usize = 74;
}

/// The tier a `TierResult` proves for `borrower` at `now`, or 0 for anything else: not owned by
/// `zenlo_credit_mxe`, not at `["arcium-tier", borrower]`, malformed, another borrower, never
/// computed, computed from a stale attestation, income credential expired, or a tier outside 1–3.
pub fn read_tier_result(owner: &Pubkey, key: &Pubkey, lamports: u64, data: &[u8], borrower: &Pubkey, now: i64) -> u8 {
    use tier_offsets::*;
    if lamports == 0 || *owner != CREDIT_MXE_ID || data.len() < TIER_RESULT_LEN || data[..8] != TIER_RESULT_DISCRIMINATOR {
        return 0;
    }
    let (expected, _) = Pubkey::find_program_address(&[TIER_RESULT_SEED, borrower.as_ref()], &CREDIT_MXE_ID);
    if *key != expected || data[VERSION] != TIER_RESULT_VERSION || key_at(data, BORROWER) != *borrower {
        return 0;
    }
    let tier = data[TIER];
    if i64_at(data, COMPUTED_AT) <= 0 || !fresh(i64_at(data, ATTESTED_AT), now) || i64_at(data, INCOME_VALID_UNTIL) <= now || !(1..=3).contains(&tier) {
        return 0;
    }
    tier
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_rows() {
        let t = |on_time, late, liquidated, defaulted, income_band| tier(TierInputs { on_time, late, liquidated, defaulted, income_band });
        assert_eq!(t(6, 0, 0, 0, 3), 3);
        assert_eq!(t(60, 0, 0, 0, 3), 3);
        assert_eq!(t(5, 0, 0, 0, 3), 2);
        assert_eq!(t(6, 1, 0, 0, 3), 2);
        assert_eq!(t(6, 0, 1, 0, 3), 1);
        assert_eq!(t(6, 0, 0, 0, 2), 2);
        assert_eq!(t(3, 1, 0, 0, 2), 2);
        assert_eq!(t(3, 2, 0, 0, 2), 0);
        assert_eq!(t(2, 0, 0, 0, 3), 1);
        assert_eq!(t(1, 1, 0, 0, 1), 1);
        assert_eq!(t(1, 1, 1, 0, 1), 0);
        assert_eq!(t(0, 0, 0, 0, 3), 0);
        assert_eq!(t(9, 0, 0, 1, 3), 0);
        assert_eq!(t(9, 0, 0, 0, 0), 0);
        assert_eq!(t(9, 0, 0, 0, 1), 1);
        assert_eq!(t(u32::MAX, u32::MAX, u32::MAX, 0, 3), 0);
    }

    #[test]
    fn freshness() {
        let now = 10_000_000;
        assert!(fresh(now, now));
        assert!(fresh(now - MAX_ATTESTATION_AGE_SECONDS, now));
        assert!(!fresh(now - MAX_ATTESTATION_AGE_SECONDS - 1, now));
        assert!(fresh(now + MAX_FUTURE_SKEW_SECONDS, now));
        assert!(!fresh(now + MAX_FUTURE_SKEW_SECONDS + 1, now));
        assert!(!fresh(0, now));
    }
}
