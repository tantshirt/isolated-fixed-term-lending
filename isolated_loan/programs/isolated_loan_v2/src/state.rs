use anchor_lang::prelude::*;
use loan_core::accounting::{EarlyRepayment, Ledger, TermsV2};

pub const ACCOUNT_VERSION: u8 = 2;

/// One V2 loan, from open offer to terminal settlement. Seeds use the immutable `origin_lender`,
/// so the PDA keeps signing if the position is ever sold; repayments and claims go to
/// `current_lender`.
#[account]
#[derive(InitSpace)]
pub struct OfferV2 {
    pub version: u8,
    pub origin_lender: Pubkey,
    pub current_lender: Pubkey,
    /// Default until accepted.
    pub borrower: Pubkey,
    /// Default means anyone may accept; otherwise only this wallet (renewal offers).
    pub restricted_borrower: Pubkey,
    pub offer_id: u64,
    pub usdc_mint: Pubkey,
    pub wsol_mint: Pubkey,
    pub terms: TermsState,
    /// Collateral required at accept.
    pub collateral_required: u64,
    /// wSOL currently held for this loan (grows with top-ups).
    pub collateral_locked: u64,
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
    pub status: StatusV2,
    pub ledger: LedgerState,
    /// Payoff the collateral did not cover, recorded at priced recovery.
    pub shortfall: u64,
    pub settled_ts: i64,
    pub bump: u8,
    pub reserved: [u8; 64],
}

impl OfferV2 {
    /// Story 26.7: the credit tier fixed at origination (0 = standard caps). Stored in
    /// `reserved[crate::credit::CREDIT_TIER_INDEX]` (account byte 416), so the layout is unchanged.
    pub fn credit_tier(&self) -> u8 {
        self.reserved[crate::credit::CREDIT_TIER_INDEX]
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum StatusV2 {
    Open,
    Active,
    Repaid,
    Liquidated,
    OverdueLiquidated,
    PricedRecovered,
    TerminalClaimed,
    Cancelled,
    /// Moved into a new loan by `refinance_into` (Story 26.1). Appended so existing discriminants
    /// do not move; never counted as a repayment.
    Refinanced,
}

impl StatusV2 {
    pub fn is_settled(self) -> bool {
        !matches!(self, StatusV2::Open | StatusV2::Active)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default, InitSpace)]
pub struct TermsState {
    pub principal: u64,
    pub interest_bps: u16,
    pub duration: i64,
    /// 0 full-term, 1 pro-rata.
    pub early_repayment: u8,
    pub min_interest_bps: u16,
    pub grace_seconds: i64,
    pub late_fee_bps: u16,
    pub annual_ceiling_bps: u16,
    /// Zero until accepted.
    pub start_ts: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default, InitSpace)]
pub struct LedgerState {
    pub outstanding_principal: u64,
    pub interest_accrued: u64,
    pub interest_paid: u64,
    pub accrual_remainder: u128,
    pub last_accrual_ts: i64,
    pub late_fee_assessed: u64,
    pub late_fee_paid: u64,
    pub late_fee_checked: bool,
}

impl TermsState {
    pub fn core(&self) -> Result<TermsV2> {
        Ok(TermsV2 {
            principal: self.principal,
            interest_bps: self.interest_bps,
            duration: self.duration,
            start_ts: self.start_ts,
            early_repayment: EarlyRepayment::from_u8(self.early_repayment).map_err(crate::error::core_error)?,
            min_interest_bps: self.min_interest_bps,
            grace_seconds: self.grace_seconds,
            late_fee_bps: self.late_fee_bps,
            annual_ceiling_bps: self.annual_ceiling_bps,
        })
    }
}

impl From<Ledger> for LedgerState {
    fn from(l: Ledger) -> Self {
        LedgerState {
            outstanding_principal: l.outstanding_principal,
            interest_accrued: l.interest_accrued,
            interest_paid: l.interest_paid,
            accrual_remainder: l.accrual_remainder,
            last_accrual_ts: l.last_accrual_ts,
            late_fee_assessed: l.late_fee_assessed,
            late_fee_paid: l.late_fee_paid,
            late_fee_checked: l.late_fee_checked,
        }
    }
}

impl From<LedgerState> for Ledger {
    fn from(l: LedgerState) -> Self {
        Ledger {
            outstanding_principal: l.outstanding_principal,
            interest_accrued: l.interest_accrued,
            interest_paid: l.interest_paid,
            accrual_remainder: l.accrual_remainder,
            last_accrual_ts: l.last_accrual_ts,
            late_fee_assessed: l.late_fee_assessed,
            late_fee_paid: l.late_fee_paid,
            late_fee_checked: l.late_fee_checked,
        }
    }
}

/// A borrower's public ask with collateral locked. Funding turns it into an active `OfferV2`.
#[account]
#[derive(InitSpace)]
pub struct RequestV2 {
    pub version: u8,
    pub borrower: Pubkey,
    pub request_id: u64,
    pub usdc_mint: Pubkey,
    pub wsol_mint: Pubkey,
    pub terms: TermsState,
    pub collateral_amount: u64,
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
    pub created_ts: i64,
    pub status: RequestStatusV2,
    pub lender: Pubkey,
    pub offer: Pubkey,
    pub bump: u8,
    pub reserved: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RequestStatusV2 {
    Open,
    Funded,
    Cancelled,
}

/// Arguments shared by create_offer and create_request.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct TermsArgs {
    pub principal: u64,
    pub interest_bps: u16,
    pub duration: i64,
    pub early_repayment: u8,
    pub min_interest_bps: u16,
    pub grace_seconds: i64,
    pub late_fee_bps: u16,
    pub annual_ceiling_bps: u16,
    pub collateral_amount: u64,
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
}

impl TermsArgs {
    pub fn terms(&self) -> TermsState {
        TermsState {
            principal: self.principal,
            interest_bps: self.interest_bps,
            duration: self.duration,
            early_repayment: self.early_repayment,
            min_interest_bps: self.min_interest_bps,
            grace_seconds: self.grace_seconds,
            late_fee_bps: self.late_fee_bps,
            annual_ceiling_bps: self.annual_ceiling_bps,
            start_ts: 0,
        }
    }

    /// Every V1 cap plus every V2 rule, checked as if the loan started now.
    pub fn validate(&self, now: i64) -> Result<()> {
        require!(self.collateral_amount > 0, crate::error::LoanV2Error::InvalidTerms);
        loan_core::math::validate_terms(self.interest_bps, self.duration, self.max_ltv_bps, self.liquidation_ltv_bps)
            .map_err(crate::error::core_error)?;
        let mut t = self.terms();
        t.start_ts = now;
        t.core()?.validate().map_err(crate::error::core_error)
    }
}
