//! Automation mandates (Story 26.3, research.md § Automation mandates).
//!
//! One rule set for `isolated_loan_v2` (keeper-executed) and `private_loan_v2` (evaluated by the
//! rollup watcher). Pure functions only; each program maps `MandateError` onto its own error
//! enum. The legacy programs never call this module.

/// What the mandate does when it fires.
pub const ACTION_TOP_UP: u8 = 0;
pub const ACTION_REPAY: u8 = 1;

/// When it fires.
pub const TRIGGER_HEALTH: u8 = 0;
pub const TRIGGER_TIME: u8 = 1;

/// A fired health trigger re-arms only once LTV is at least this far below the trigger.
pub const REARM_GAP_BPS: u16 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MandateError {
    /// A bound is missing, zero, inconsistent, or outside the loan's limits.
    InvalidBounds,
    /// Past the signed expiry.
    Expired,
    /// The trigger is not true now, or has fired and not re-armed.
    NotTriggered,
    /// The cumulative cap leaves nothing to move after the fee.
    CapReached,
    /// The requested fee is above `fee_per_exec` or would pass `fee_cap`.
    FeeAboveCap,
    MathOverflow,
}

pub type MandateResult<T> = core::result::Result<T, MandateError>;

/// Every bound the borrower signs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bounds {
    pub action: u8,
    pub trigger: u8,
    /// Health trigger only: fires at or above this conservative spot LTV.
    pub trigger_ltv_bps: u16,
    /// Time trigger only: fires once from `maturity - lead_seconds`.
    pub lead_seconds: i64,
    pub amount_per_exec: u64,
    /// Everything drawn from the allowance, amounts and fees together.
    pub cumulative_cap: u64,
    pub fee_per_exec: u64,
    pub fee_cap: u64,
    pub expiry: i64,
}

impl Bounds {
    /// Checked at creation against the loan it binds to.
    pub fn validate(&self, now: i64, liquidation_ltv_bps: u16, duration: i64) -> MandateResult<()> {
        let ok_action = self.action == ACTION_TOP_UP || self.action == ACTION_REPAY;
        let ok_trigger = match self.trigger {
            TRIGGER_HEALTH => self.trigger_ltv_bps > REARM_GAP_BPS && self.trigger_ltv_bps < liquidation_ltv_bps && self.lead_seconds == 0,
            TRIGGER_TIME => self.lead_seconds > 0 && self.lead_seconds <= duration && self.trigger_ltv_bps == 0,
            _ => false,
        };
        let ok_amounts = self.amount_per_exec > 0
            && self.cumulative_cap > 0
            && self.fee_cap <= self.cumulative_cap
            && self.fee_per_exec <= self.fee_cap;
        if ok_action && ok_trigger && ok_amounts && self.expiry > now {
            Ok(())
        } else {
            Err(MandateError::InvalidBounds)
        }
    }

    /// Re-arm level for a fired health trigger.
    pub fn rearm_ltv_bps(&self) -> u16 {
        self.trigger_ltv_bps.saturating_sub(REARM_GAP_BPS)
    }
}

/// Whether an armed mandate fires now. `ltv_bps` is the conservative spot LTV of the payoff; it
/// is needed only by the health trigger (None there means no valid price, so nothing fires).
pub fn fires(b: &Bounds, armed: bool, now: i64, maturity: i64, ltv_bps: Option<u16>) -> MandateResult<()> {
    if now >= b.expiry {
        return Err(MandateError::Expired);
    }
    if !armed {
        return Err(MandateError::NotTriggered);
    }
    let due = match b.trigger {
        TRIGGER_HEALTH => matches!(ltv_bps, Some(l) if l >= b.trigger_ltv_bps),
        TRIGGER_TIME => now >= maturity.saturating_sub(b.lead_seconds),
        _ => false,
    };
    if due {
        Ok(())
    } else {
        Err(MandateError::NotTriggered)
    }
}

/// A fired health trigger may re-arm at this LTV. A time trigger never re-arms.
pub fn may_rearm(b: &Bounds, armed: bool, ltv_bps: u16) -> bool {
    !armed && b.trigger == TRIGGER_HEALTH && ltv_bps <= b.rearm_ltv_bps()
}

/// One execution's movement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    /// To the loan (collateral vault or the lender).
    pub amount: u64,
    /// To the executor.
    pub fee: u64,
}

/// The fixed amount clamped to what the cumulative cap leaves after the fee and, for a repay, to
/// the payoff. The fee must sit within both fee bounds; it is never clamped silently.
pub fn plan(b: &Bounds, used: u64, fees_paid: u64, fee: u64, payoff: Option<u64>) -> MandateResult<Plan> {
    let fees_after = fees_paid.checked_add(fee).ok_or(MandateError::MathOverflow)?;
    if fee > b.fee_per_exec || fees_after > b.fee_cap {
        return Err(MandateError::FeeAboveCap);
    }
    let left = b.cumulative_cap.saturating_sub(used).saturating_sub(fee);
    let mut amount = b.amount_per_exec.min(left);
    if let Some(p) = payoff {
        amount = amount.min(p);
    }
    if amount == 0 {
        return Err(MandateError::CapReached);
    }
    Ok(Plan { amount, fee })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn health() -> Bounds {
        Bounds {
            action: ACTION_TOP_UP,
            trigger: TRIGGER_HEALTH,
            trigger_ltv_bps: 7_500,
            lead_seconds: 0,
            amount_per_exec: 100,
            cumulative_cap: 250,
            fee_per_exec: 5,
            fee_cap: 10,
            expiry: 1_000,
        }
    }

    #[test]
    fn bounds_must_be_consistent() {
        assert_eq!(health().validate(0, 8_000, 100), Ok(()));
        assert_eq!(Bounds { trigger_ltv_bps: 8_000, ..health() }.validate(0, 8_000, 100), Err(MandateError::InvalidBounds));
        assert_eq!(Bounds { trigger_ltv_bps: 200, ..health() }.validate(0, 8_000, 100), Err(MandateError::InvalidBounds));
        assert_eq!(Bounds { fee_cap: 300, ..health() }.validate(0, 8_000, 100), Err(MandateError::InvalidBounds));
        assert_eq!(Bounds { fee_per_exec: 11, ..health() }.validate(0, 8_000, 100), Err(MandateError::InvalidBounds));
        assert_eq!(health().validate(1_000, 8_000, 100), Err(MandateError::InvalidBounds));
        let time = Bounds { trigger: TRIGGER_TIME, trigger_ltv_bps: 0, lead_seconds: 50, ..health() };
        assert_eq!(time.validate(0, 8_000, 100), Ok(()));
        assert_eq!(Bounds { lead_seconds: 101, ..time }.validate(0, 8_000, 100), Err(MandateError::InvalidBounds));
        assert_eq!(Bounds { action: 2, ..health() }.validate(0, 8_000, 100), Err(MandateError::InvalidBounds));
    }

    #[test]
    fn health_trigger_fires_then_needs_the_gap_to_rearm() {
        let b = health();
        assert_eq!(fires(&b, true, 0, 500, Some(7_499)), Err(MandateError::NotTriggered));
        assert_eq!(fires(&b, true, 0, 500, Some(7_500)), Ok(()));
        assert_eq!(fires(&b, true, 0, 500, None), Err(MandateError::NotTriggered));
        assert_eq!(fires(&b, false, 0, 500, Some(9_000)), Err(MandateError::NotTriggered));
        assert!(!may_rearm(&b, false, 7_301));
        assert!(may_rearm(&b, false, 7_300));
        assert!(!may_rearm(&b, true, 7_000));
        assert_eq!(fires(&b, true, 1_000, 500, Some(9_000)), Err(MandateError::Expired));
    }

    #[test]
    fn time_trigger_fires_from_the_lead_and_never_rearms() {
        let b = Bounds { trigger: TRIGGER_TIME, trigger_ltv_bps: 0, lead_seconds: 50, ..health() };
        assert_eq!(fires(&b, true, 449, 500, None), Err(MandateError::NotTriggered));
        assert_eq!(fires(&b, true, 450, 500, None), Ok(()));
        assert!(!may_rearm(&b, false, 0));
    }

    #[test]
    fn amounts_clamp_to_the_cap_and_payoff_and_fees_never_pass_their_bounds() {
        let b = health();
        assert_eq!(plan(&b, 0, 0, 5, None), Ok(Plan { amount: 100, fee: 5 }));
        // 250 cap, 210 used, fee 5: 35 left.
        assert_eq!(plan(&b, 210, 5, 5, None), Ok(Plan { amount: 35, fee: 5 }));
        assert_eq!(plan(&b, 245, 5, 5, None), Err(MandateError::CapReached));
        assert_eq!(plan(&b, 0, 0, 6, None), Err(MandateError::FeeAboveCap));
        assert_eq!(plan(&b, 0, 8, 5, None), Err(MandateError::FeeAboveCap));
        assert_eq!(plan(&b, 0, 0, 0, Some(40)), Ok(Plan { amount: 40, fee: 0 }));
    }
}
