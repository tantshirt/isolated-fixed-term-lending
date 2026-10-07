//! V2 loan accounting (Story 20.1). One model for both V2 programs, the TypeScript client,
//! simulation, alerts and keepers. Formulas and rounding are stated in `docs/research.md`.
//!
//! Every function takes the clock as an argument, so a test can step through any boundary.

use crate::math::{collateral_value_usdc, current_ltv_bps, seize_usdc, wsol_to_caller};
use crate::{CoreError, CoreResult};

pub const SECONDS_PER_YEAR: u128 = 31_536_000;
pub const DEFAULT_GRACE_SECONDS: i64 = 86_400;
pub const MIN_GRACE_SECONDS: i64 = 86_400;
pub const MAX_GRACE_SECONDS: i64 = 172_800;
pub const DEFAULT_LATE_FEE_BPS: u16 = 100;
pub const MAX_LATE_FEE_BPS: u16 = 500;
pub const DEFAULT_MIN_INTEREST_BPS: u16 = 2_500;
/// Devnet test setting: the highest annual pricing ceiling any V2 loan may declare (600%).
pub const PROTOCOL_MAX_ANNUAL_CEILING_BPS: u16 = 60_000;
/// Priced recovery opens this long after grace ends.
pub const PRICED_RECOVERY_DELAY: i64 = 86_400;
/// The terminal whole-collateral claim opens this long after grace ends.
pub const TERMINAL_CLAIM_DELAY: i64 = 604_800;
/// Emergency liquidation accepts spot alone at this many LTV basis points past the threshold.
pub const EMERGENCY_LTV_MARGIN_BPS: u16 = 300;

macro_rules! ensure {
    ($cond:expr, $err:expr) => {
        if !$cond {
            return Err($err);
        }
    };
}

fn to_u64(v: u128) -> CoreResult<u64> {
    u64::try_from(v).map_err(|_| CoreError::MathOverflow)
}

fn ceil_div(num: u128, den: u128) -> u128 {
    (num + den - 1) / den
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum EarlyRepayment {
    /// The full-term interest is owed whenever the borrower repays (the legacy rule).
    FullTerm = 0,
    /// Interest accrues on outstanding principal until maturity, with a minimum at final payoff.
    ProRata = 1,
}

impl EarlyRepayment {
    pub fn from_u8(v: u8) -> CoreResult<Self> {
        match v {
            0 => Ok(Self::FullTerm),
            1 => Ok(Self::ProRata),
            _ => Err(CoreError::InvalidTerms),
        }
    }
}

/// Terms fixed at origination. Nothing here changes after a loan starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TermsV2 {
    pub principal: u64,
    /// Interest for the whole term, in basis points of principal (as in V1).
    pub interest_bps: u16,
    pub duration: i64,
    pub start_ts: i64,
    pub early_repayment: EarlyRepayment,
    /// Minimum interest at final payoff, in basis points of the full-term interest (pro-rata only).
    pub min_interest_bps: u16,
    pub grace_seconds: i64,
    pub late_fee_bps: u16,
    /// Annual pricing ceiling over the contract period (term plus grace), in basis points.
    pub annual_ceiling_bps: u16,
}

impl TermsV2 {
    pub fn maturity(&self) -> i64 {
        self.start_ts + self.duration
    }
    pub fn grace_end(&self) -> i64 {
        self.maturity() + self.grace_seconds
    }
    pub fn priced_recovery_from(&self) -> i64 {
        self.grace_end() + PRICED_RECOVERY_DELAY
    }
    pub fn terminal_claim_from(&self) -> i64 {
        self.grace_end() + TERMINAL_CLAIM_DELAY
    }

    /// ceil(P0 * bps / 10_000), the V1 interest.
    pub fn full_term_interest(&self) -> CoreResult<u64> {
        crate::math::interest(self.principal, self.interest_bps)
    }

    /// floor(P0 * ceiling * (term + grace) / (10_000 * 365 days)). Rounds down: it is a maximum.
    pub fn charge_ceiling(&self) -> CoreResult<u64> {
        let period = (self.duration + self.grace_seconds) as u128;
        let num = (self.principal as u128)
            .checked_mul(self.annual_ceiling_bps as u128)
            .and_then(|v| v.checked_mul(period))
            .ok_or(CoreError::MathOverflow)?;
        to_u64(num / (10_000 * SECONDS_PER_YEAR))
    }

    /// The pro-rata floor, never above the ceiling.
    pub fn min_interest(&self) -> CoreResult<u64> {
        if self.early_repayment == EarlyRepayment::FullTerm {
            return Ok(0);
        }
        let full = self.full_term_interest()? as u128;
        let floor = to_u64(ceil_div(full * self.min_interest_bps as u128, 10_000))?;
        Ok(floor.min(self.charge_ceiling()?))
    }

    /// The most the borrower could ever owe under these terms. Origination LTV uses this.
    pub fn max_exposure(&self) -> CoreResult<u64> {
        let fee = to_u64(ceil_div(self.principal as u128 * self.late_fee_bps as u128, 10_000))?;
        let charges = self
            .full_term_interest()?
            .checked_add(fee)
            .ok_or(CoreError::MathOverflow)?
            .min(self.charge_ceiling()?);
        self.principal.checked_add(charges).ok_or(CoreError::MathOverflow)
    }

    pub fn validate(&self) -> CoreResult<()> {
        ensure!(self.principal > 0, CoreError::InvalidTerms);
        ensure!(self.interest_bps <= crate::constants::MAX_INTEREST_BPS, CoreError::InvalidTerms);
        ensure!(
            self.duration >= crate::constants::MIN_DURATION_SECONDS && self.duration <= crate::constants::MAX_DURATION_SECONDS,
            CoreError::InvalidTerms
        );
        ensure!(self.grace_seconds >= MIN_GRACE_SECONDS && self.grace_seconds <= MAX_GRACE_SECONDS, CoreError::InvalidTerms);
        ensure!(self.late_fee_bps <= MAX_LATE_FEE_BPS, CoreError::InvalidTerms);
        ensure!(self.min_interest_bps <= 10_000, CoreError::InvalidTerms);
        ensure!(
            self.annual_ceiling_bps > 0 && self.annual_ceiling_bps <= PROTOCOL_MAX_ANNUAL_CEILING_BPS,
            CoreError::InvalidTerms
        );
        // The stated rate must fit under the stated ceiling; the ceiling then only clamps fees.
        ensure!(self.full_term_interest()? <= self.charge_ceiling()?, CoreError::InvalidTerms);
        Ok(())
    }
}

/// Mutable accounting for one loan.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Ledger {
    pub outstanding_principal: u64,
    pub interest_accrued: u64,
    pub interest_paid: u64,
    /// Numerator remainder of pro-rata accrual, always below 10_000 * duration.
    pub accrual_remainder: u128,
    pub last_accrual_ts: i64,
    pub late_fee_assessed: u64,
    pub late_fee_paid: u64,
    pub late_fee_checked: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Payment {
    /// Amount actually taken. Never more than the payoff.
    pub used: u64,
    pub interest: u64,
    pub late_fee: u64,
    pub principal: u64,
    /// One-time rounding and minimum-interest adjustment, charged only at final payoff.
    pub adjustment: u64,
    /// True only when everything owed is paid.
    pub closed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Active,
    Grace,
    Overdue,
    PricedRecovery,
    Terminal,
}

pub fn open(terms: &TermsV2) -> CoreResult<Ledger> {
    terms.validate()?;
    let interest_accrued = match terms.early_repayment {
        EarlyRepayment::FullTerm => terms.full_term_interest()?,
        EarlyRepayment::ProRata => 0,
    };
    Ok(Ledger { outstanding_principal: terms.principal, interest_accrued, last_accrual_ts: terms.start_ts, ..Ledger::default() })
}

pub fn phase(terms: &TermsV2, now: i64) -> Phase {
    if now < terms.maturity() {
        Phase::Active
    } else if now < terms.grace_end() {
        Phase::Grace
    } else if now < terms.priced_recovery_from() {
        Phase::Overdue
    } else if now < terms.terminal_claim_from() {
        Phase::PricedRecovery
    } else {
        Phase::Terminal
    }
}

fn charges(l: &Ledger) -> CoreResult<u64> {
    l.interest_paid
        .checked_add(l.interest_accrued)
        .and_then(|v| v.checked_add(l.late_fee_assessed))
        .ok_or(CoreError::MathOverflow)
}

fn headroom(terms: &TermsV2, l: &Ledger) -> CoreResult<u64> {
    Ok(terms.charge_ceiling()?.saturating_sub(charges(l)?))
}

/// Pro-rata accrual on outstanding principal, up to maturity, carrying the remainder.
pub fn accrue(terms: &TermsV2, l: &Ledger, now: i64) -> CoreResult<Ledger> {
    let mut l = *l;
    if terms.early_repayment != EarlyRepayment::ProRata {
        return Ok(l);
    }
    let t = now.min(terms.maturity());
    if t <= l.last_accrual_ts {
        return Ok(l);
    }
    let dt = (t - l.last_accrual_ts) as u128;
    let den = 10_000u128 * terms.duration as u128;
    let num = (l.outstanding_principal as u128)
        .checked_mul(terms.interest_bps as u128)
        .and_then(|v| v.checked_mul(dt))
        .and_then(|v| v.checked_add(l.accrual_remainder))
        .ok_or(CoreError::MathOverflow)?;
    let mut whole = to_u64(num / den)?;
    let mut remainder = num % den;
    // At maturity the term's interest is complete: round the remainder up once, as V1 does, and
    // before the late fee is assessed so contract interest takes the ceiling's room first.
    if t == terms.maturity() && remainder > 0 {
        whole += 1;
        remainder = 0;
    }
    l.interest_accrued = l.interest_accrued.checked_add(whole.min(headroom(terms, &l)?)).ok_or(CoreError::MathOverflow)?;
    l.accrual_remainder = remainder;
    l.last_accrual_ts = t;
    Ok(l)
}

/// One-time late fee on principal still unpaid at maturity, clamped to the ceiling.
pub fn assess_late_fee(terms: &TermsV2, l: &Ledger, now: i64) -> CoreResult<Ledger> {
    let mut l = *l;
    if now < terms.maturity() || l.late_fee_checked {
        return Ok(l);
    }
    let fee = to_u64(ceil_div(l.outstanding_principal as u128 * terms.late_fee_bps as u128, 10_000))?;
    l.late_fee_assessed = fee.min(headroom(terms, &l)?);
    l.late_fee_checked = true;
    Ok(l)
}

/// Brings the ledger up to `now`. Every instruction calls this before anything else.
pub fn sync(terms: &TermsV2, l: &Ledger, now: i64) -> CoreResult<Ledger> {
    assess_late_fee(terms, &accrue(terms, l, now)?, now)
}

/// The one-time amount added at final payoff: the accrual remainder rounded up, then any
/// shortfall against the minimum interest. Both stay under the ceiling.
fn final_adjustment(terms: &TermsV2, l: &Ledger) -> CoreResult<u64> {
    if terms.early_repayment != EarlyRepayment::ProRata {
        return Ok(0);
    }
    let room = headroom(terms, l)?;
    let roundup = u64::from(l.accrual_remainder > 0).min(room);
    let interest = l.interest_paid as u128 + l.interest_accrued as u128 + roundup as u128;
    let floor_gap = to_u64((terms.min_interest()? as u128).saturating_sub(interest))?;
    Ok(roundup + floor_gap.min(room - roundup))
}

/// What closes the loan now. Health, liquidation and settlement all use this figure.
pub fn payoff(terms: &TermsV2, l: &Ledger, now: i64) -> CoreResult<u64> {
    let l = sync(terms, l, now)?;
    let late_due = l.late_fee_assessed - l.late_fee_paid;
    [l.interest_accrued, late_due, final_adjustment(terms, &l)?]
        .iter()
        .try_fold(l.outstanding_principal, |acc, v| acc.checked_add(*v))
        .ok_or(CoreError::MathOverflow)
}

/// Applies a payment: accrued interest, then late fees, then principal. A payment that covers
/// the payoff closes the loan and takes only the payoff.
pub fn apply_payment(terms: &TermsV2, l: &Ledger, now: i64, amount: u64) -> CoreResult<(Ledger, Payment)> {
    ensure!(amount > 0, CoreError::InvalidTerms);
    let mut l = sync(terms, l, now)?;
    let late_due = l.late_fee_assessed - l.late_fee_paid;
    let total = payoff(terms, &l, now)?;
    if amount >= total {
        let adjustment = final_adjustment(terms, &l)?;
        let p = Payment {
            used: total,
            interest: l.interest_accrued,
            late_fee: late_due,
            principal: l.outstanding_principal,
            adjustment,
            closed: true,
        };
        l.interest_paid += l.interest_accrued + adjustment;
        l.interest_accrued = 0;
        l.accrual_remainder = 0;
        l.late_fee_paid = l.late_fee_assessed;
        l.outstanding_principal = 0;
        return Ok((l, p));
    }
    let mut left = amount;
    let interest = left.min(l.interest_accrued);
    left -= interest;
    let late_fee = left.min(late_due);
    left -= late_fee;
    let principal = left.min(l.outstanding_principal);
    left -= principal;
    l.interest_accrued -= interest;
    l.interest_paid += interest;
    l.late_fee_paid += late_fee;
    l.outstanding_principal -= principal;
    Ok((l, Payment { used: amount - left, interest, late_fee, principal, adjustment: 0, closed: false }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiquidationKind {
    /// Conservative spot and EMA both at or past the threshold.
    Ordinary,
    /// Conservative spot alone, at least `EMERGENCY_LTV_MARGIN_BPS` past the threshold.
    Emergency,
}

/// Risk liquidation trigger. `ema_ltv_bps` is None when the EMA failed its own checks; an
/// invalid spot never reaches this function.
pub fn liquidation_trigger(spot_ltv_bps: u16, ema_ltv_bps: Option<u16>, threshold_bps: u16) -> Option<LiquidationKind> {
    if spot_ltv_bps >= threshold_bps && ema_ltv_bps.map_or(false, |e| e >= threshold_bps) {
        return Some(LiquidationKind::Ordinary);
    }
    if spot_ltv_bps >= threshold_bps.saturating_add(EMERGENCY_LTV_MARGIN_BPS) {
        return Some(LiquidationKind::Emergency);
    }
    None
}

/// LTV of the current payoff against collateral valued at (price - conf).
pub fn ltv_bps(payoff: u64, lamports: u64, price: i64, conf: u64, exponent: i32) -> CoreResult<u16> {
    current_ltv_bps(payoff, collateral_value_usdc(lamports, price, conf, exponent)?)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CollateralSplit {
    /// To the liquidator (with incentive) or the lender (priced recovery, no incentive).
    pub to_recipient: u64,
    pub to_borrower: u64,
    /// USDC atoms of payoff the collateral did not cover (priced recovery only).
    pub shortfall: u64,
}

/// Risk or overdue liquidation: the caller pays the payoff and takes collateral worth payoff + 5%.
pub fn liquidation_split(payoff: u64, lamports: u64, value_usdc: u64) -> CoreResult<CollateralSplit> {
    let to_caller = wsol_to_caller(lamports, seize_usdc(payoff)?, value_usdc)?;
    Ok(CollateralSplit { to_recipient: to_caller, to_borrower: lamports - to_caller, shortfall: 0 })
}

/// Priced recovery: the lender takes collateral worth the payoff with no bonus; any surplus goes
/// back to the borrower and any uncovered amount is recorded as a shortfall.
pub fn priced_recovery_split(payoff: u64, lamports: u64, value_usdc: u64) -> CoreResult<CollateralSplit> {
    let to_lender = wsol_to_caller(lamports, payoff, value_usdc)?;
    let shortfall = payoff.saturating_sub(value_usdc);
    Ok(CollateralSplit { to_recipient: to_lender, to_borrower: lamports - to_lender, shortfall })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400;

    fn terms(policy: EarlyRepayment) -> TermsV2 {
        TermsV2 {
            principal: 100_000_000,
            interest_bps: 500,
            duration: 30 * DAY,
            start_ts: 1_800_000_000,
            early_repayment: policy,
            min_interest_bps: DEFAULT_MIN_INTEREST_BPS,
            grace_seconds: DEFAULT_GRACE_SECONDS,
            late_fee_bps: DEFAULT_LATE_FEE_BPS,
            annual_ceiling_bps: 10_000,
        }
    }

    #[test]
    fn pro_rata_with_no_payments_equals_legacy_debt() {
        let t = terms(EarlyRepayment::ProRata);
        let l = open(&t).unwrap();
        let legacy = crate::math::debt(t.principal, t.interest_bps).unwrap();
        // Accrual runs to maturity; from maturity the one-time late fee is added on top.
        let fee = sync(&t, &l, t.maturity()).unwrap().late_fee_assessed;
        assert_eq!(payoff(&t, &l, t.maturity()).unwrap(), legacy + fee);
        // An odd principal leaves a remainder that is rounded up exactly once, matching V1's ceiling.
        let odd = TermsV2 { principal: 100_000_003, ..t };
        let ol = open(&odd).unwrap();
        let ofee = sync(&odd, &ol, odd.maturity()).unwrap().late_fee_assessed;
        assert_eq!(payoff(&odd, &ol, odd.maturity()).unwrap(), crate::math::debt(odd.principal, odd.interest_bps).unwrap() + ofee);
    }

    #[test]
    fn early_payoff_respects_the_minimum_interest() {
        let t = terms(EarlyRepayment::ProRata);
        let l = open(&t).unwrap();
        // One day in: 1/30 of 5 USDC accrued, but the floor is 25% of 5 USDC.
        assert_eq!(payoff(&t, &l, t.start_ts + DAY).unwrap(), 100_000_000 + 1_250_000);
        // Two thirds in, accrual is above the floor.
        assert_eq!(payoff(&t, &l, t.start_ts + 20 * DAY).unwrap(), 100_000_000 + 3_333_334);
    }

    #[test]
    fn full_term_owes_everything_from_the_start() {
        let t = terms(EarlyRepayment::FullTerm);
        let l = open(&t).unwrap();
        assert_eq!(payoff(&t, &l, t.start_ts + 1).unwrap(), 105_000_000);
    }

    #[test]
    fn payments_go_to_interest_then_late_fee_then_principal() {
        let t = terms(EarlyRepayment::ProRata);
        let l = open(&t).unwrap();
        let (l, p) = apply_payment(&t, &l, t.maturity() + 10, 2_000_000).unwrap();
        // At maturity: 5 USDC interest accrued and a 1 USDC late fee.
        assert_eq!((p.interest, p.late_fee, p.principal, p.closed), (2_000_000, 0, 0, false));
        let (l, p) = apply_payment(&t, &l, t.maturity() + 20, 5_000_000).unwrap();
        assert_eq!((p.interest, p.late_fee, p.principal), (3_000_000, 1_000_000, 1_000_000));
        assert_eq!(l.outstanding_principal, 99_000_000);
        let rest = payoff(&t, &l, t.maturity() + 30).unwrap();
        assert_eq!(rest, 99_000_000);
        let (l, p) = apply_payment(&t, &l, t.maturity() + 30, u64::MAX).unwrap();
        assert!(p.closed);
        assert_eq!(p.used, rest);
        assert_eq!(l.interest_paid, 5_000_000);
        assert_eq!(l.late_fee_paid, 1_000_000);
    }

    #[test]
    fn principal_at_zero_is_not_repayment_while_charges_remain() {
        let t = terms(EarlyRepayment::ProRata);
        let l = open(&t).unwrap();
        // Pay the principal one hour in; the minimum interest is still owed.
        let now = t.start_ts + 3_600;
        let accrued = sync(&t, &l, now).unwrap().interest_accrued;
        let (l, p) = apply_payment(&t, &l, now, accrued + 100_000_000).unwrap();
        assert!(!p.closed);
        assert_eq!(l.outstanding_principal, 0);
        assert!(payoff(&t, &l, now).unwrap() > 0);
        let (_, p) = apply_payment(&t, &l, now, u64::MAX).unwrap();
        assert!(p.closed);
    }

    #[test]
    fn repeated_small_payments_do_not_inflate_rounding() {
        let t = TermsV2 { principal: 100_000_003, ..terms(EarlyRepayment::ProRata) };
        let mut l = open(&t).unwrap();
        let mut paid = 0u64;
        let mut now = t.start_ts;
        while now < t.maturity() - DAY {
            now += DAY;
            let (n, p) = apply_payment(&t, &l, now, 7).unwrap();
            paid += p.used;
            l = n;
        }
        let (_, p) = apply_payment(&t, &l, now, u64::MAX).unwrap();
        paid += p.used;
        // Paying a little each day never costs more than one atom over legacy debt.
        assert!(paid <= crate::math::debt(t.principal, t.interest_bps).unwrap());
    }

    #[test]
    fn the_ceiling_clamps_the_late_fee_and_rejects_overpriced_terms() {
        // Ceiling just above the full-term interest: 5 USDC interest, period 31 days.
        let mut t = terms(EarlyRepayment::FullTerm);
        t.annual_ceiling_bps = 5_900; // floor(100e6 * 0.59 * 31/365) = 5_010_958
        assert!(t.validate().is_ok());
        let l = sync(&t, &open(&t).unwrap(), t.maturity()).unwrap();
        assert_eq!(l.late_fee_assessed, 10_958);
        assert_eq!(payoff(&t, &l, t.maturity()).unwrap(), 100_000_000 + 5_010_958);
        t.annual_ceiling_bps = 5_000;
        assert_eq!(t.validate(), Err(CoreError::InvalidTerms));
    }

    #[test]
    fn the_late_fee_is_charged_once_and_only_from_maturity() {
        let t = terms(EarlyRepayment::FullTerm);
        let l = open(&t).unwrap();
        assert_eq!(sync(&t, &l, t.maturity() - 1).unwrap().late_fee_assessed, 0);
        let l = sync(&t, &l, t.maturity()).unwrap();
        assert_eq!(l.late_fee_assessed, 1_000_000);
        assert_eq!(sync(&t, &l, t.maturity() + DAY).unwrap().late_fee_assessed, 1_000_000);
    }

    #[test]
    fn phases_change_on_exact_seconds() {
        let t = terms(EarlyRepayment::ProRata);
        assert_eq!(phase(&t, t.maturity() - 1), Phase::Active);
        assert_eq!(phase(&t, t.maturity()), Phase::Grace);
        assert_eq!(phase(&t, t.grace_end() - 1), Phase::Grace);
        assert_eq!(phase(&t, t.grace_end()), Phase::Overdue);
        assert_eq!(phase(&t, t.priced_recovery_from()), Phase::PricedRecovery);
        assert_eq!(phase(&t, t.terminal_claim_from() - 1), Phase::PricedRecovery);
        assert_eq!(phase(&t, t.terminal_claim_from()), Phase::Terminal);
    }

    #[test]
    fn emergency_needs_three_points_past_the_line() {
        assert_eq!(liquidation_trigger(8_000, Some(8_000), 8_000), Some(LiquidationKind::Ordinary));
        assert_eq!(liquidation_trigger(8_200, Some(7_000), 8_000), None);
        assert_eq!(liquidation_trigger(8_300, Some(7_000), 8_000), Some(LiquidationKind::Emergency));
        assert_eq!(liquidation_trigger(8_299, None, 8_000), None);
        assert_eq!(liquidation_trigger(7_999, Some(9_000), 8_000), None);
    }

    #[test]
    fn priced_recovery_returns_surplus_and_records_shortfall() {
        let s = priced_recovery_split(100, 1_000, 200).unwrap();
        assert_eq!((s.to_recipient, s.to_borrower, s.shortfall), (500, 500, 0));
        let s = priced_recovery_split(100, 1_000, 80).unwrap();
        assert_eq!((s.to_recipient, s.to_borrower, s.shortfall), (1_000, 0, 20));
        let s = liquidation_split(100, 1_000, 200).unwrap();
        assert_eq!((s.to_recipient, s.to_borrower), (525, 475));
    }

    #[test]
    fn validation_bounds() {
        let base = terms(EarlyRepayment::ProRata);
        for bad in [
            TermsV2 { grace_seconds: DAY - 1, ..base },
            TermsV2 { grace_seconds: 2 * DAY + 1, ..base },
            TermsV2 { late_fee_bps: 501, ..base },
            TermsV2 { min_interest_bps: 10_001, ..base },
            TermsV2 { annual_ceiling_bps: 0, ..base },
            TermsV2 { annual_ceiling_bps: PROTOCOL_MAX_ANNUAL_CEILING_BPS + 1, ..base },
            TermsV2 { principal: 0, ..base },
        ] {
            assert_eq!(bad.validate(), Err(CoreError::InvalidTerms), "{bad:?}");
        }
        assert!(TermsV2 { grace_seconds: 2 * DAY, late_fee_bps: 500, ..base }.validate().is_ok());
    }

    #[test]
    fn max_exposure_covers_interest_and_fee_under_the_ceiling() {
        let t = terms(EarlyRepayment::ProRata);
        assert_eq!(t.max_exposure().unwrap(), 106_000_000);
        let tight = TermsV2 { annual_ceiling_bps: 5_900, ..t };
        assert_eq!(tight.max_exposure().unwrap(), 105_010_958);
    }
}
