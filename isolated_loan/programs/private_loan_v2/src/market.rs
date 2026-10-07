//! Private position transfer (Story 26.8). A sale inside the rollup: both parties sign one ER
//! transaction. The buyer pays `price` from their private USDC balance to the seller's, becomes
//! `current_lender`, and the loan's read permission is rewritten so the seller loses read access
//! and the buyer gains it (consented auditors stay). The borrower's terms never change.
//!
//! There is no on-chain private listing: the price is agreed privately and bound by both
//! signatures. After a transfer, the client sends `rebind_watch` so the liquidation crank pays the
//! new lender, and a private repay mandate bound to the old lender stops until the borrower
//! creates a new one (research.md § Automation mandates, decisions).

use crate::constants::LOAN_TERMS_SEED;
use crate::desk::{current_readers, loan_readers, set_loan_readers};
use crate::error::PrivateLoanError;
use crate::loan::{require_ata, transfer, LoanAnchor, LoanTerms, STATUS_ACTIVE};
use crate::room::{load, store};
use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use ephemeral_rollups_sdk::anchor::{MagicProgram, PermissionProgram};
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use loan_core::accounting::{self as acc, Phase};

/// Checks a transfer of `t` from `seller` to `buyer` at `now` for `price`. Pure, so the rules are
/// unit-tested without the ER permission program.
pub fn check_transfer(t: &LoanTerms, seller: &Pubkey, buyer: &Pubkey, price: u64, now: i64) -> Result<()> {
    require_keys_eq!(t.current_lender, *seller, PrivateLoanError::NotLender);
    require!(t.status == STATUS_ACTIVE, PrivateLoanError::WrongStatus);
    require!(matches!(acc::phase(&t.core_terms()?, now), Phase::Active | Phase::Grace), PrivateLoanError::PositionNotSellable);
    require!(price > 0, PrivateLoanError::ZeroAmount);
    require!(*buyer != t.borrower && *buyer != *seller && *buyer != Pubkey::default(), PrivateLoanError::BuyerNotAllowed);
    Ok(())
}

/// Seller and buyer together, in the rollup. `current` is the loan's consented reader list, which
/// must hash to the recorded `auditor_hash`; it is carried over unchanged.
pub fn transfer_position(ctx: Context<TransferPosition>, price: u64, current: Vec<Pubkey>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    let (seller, buyer) = (a.seller.key(), a.buyer.key());
    check_transfer(&t, &seller, &buyer, price, Clock::get()?.unix_timestamp)?;
    let readers = current_readers(&t, current)?;
    let usdc = a.anchor.usdc_mint;
    require_ata(&a.seller_usdc, &seller, &usdc)?;
    require_ata(&a.buyer_usdc, &buyer, &usdc)?;
    transfer(&a.token_program, &a.buyer_usdc, &a.seller_usdc, &a.buyer.to_account_info(), None, price)?;

    t.current_lender = buyer;
    set_loan_readers(
        &a.anchor,
        &info,
        ctx.bumps.terms,
        &a.terms_permission.to_account_info(),
        &a.vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
        loan_readers(&t, &readers),
    )?;
    store(&info, &t)
}

#[derive(Accounts)]
pub struct TransferPosition<'info> {
    /// The current lender.
    pub seller: Signer<'info>,
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(mut, seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: The buyer's private USDC balance (eATA); checked in the handler.
    #[account(mut)]
    pub buyer_usdc: UncheckedAccount<'info>,
    /// CHECK: The seller's private USDC balance (eATA); checked in the handler.
    #[account(mut)]
    pub seller_usdc: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `terms`.
    #[account(mut)]
    pub terms_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desk::hash_readers;
    use crate::loan::{LedgerState, STATUS_REPAID};

    const DAY: i64 = 86_400;
    const START: i64 = 1_700_000_000;

    fn terms(lender: Pubkey, borrower: Pubkey) -> LoanTerms {
        let mut t = LoanTerms {
            version: 2, origin_lender: lender, current_lender: lender, borrower, room_index: 0, request_index: 0, principal: 100_000_000,
            interest_bps: 500, duration_seconds: 30 * DAY, early_repayment: 1, min_interest_bps: 2_500, grace_seconds: DAY, late_fee_bps: 100,
            annual_ceiling_bps: 10_000, collateral_required: 1, collateral_locked: 1, max_ltv_bps: 7_000, liquidation_ltv_bps: 8_000, revision: 1,
            funded_revision: 1, accepted_revision: 1, status: STATUS_ACTIVE, start_ts: START, ledger: LedgerState::default(), ledger_revision: 0,
            shortfall: 0, settled_ts: 0, desk: Pubkey::default(), policy_version: 0, auditor_hash: [0; 32],
        };
        t.ledger = acc::open(&t.core_terms().unwrap()).unwrap().into();
        t
    }

    fn code(r: Result<()>) -> u32 {
        match r.expect_err("expected a rejection") {
            Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected {other:?}"),
        }
    }

    fn err(e: PrivateLoanError) -> u32 {
        anchor_lang::error::ERROR_CODE_OFFSET + e as u32
    }

    #[test]
    fn active_and_grace_positions_transfer_to_a_new_reader() {
        let (seller, borrower, buyer, auditor) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let t = terms(seller, borrower);
        let grace_end = t.core_terms().unwrap().grace_end();
        check_transfer(&t, &seller, &buyer, 1, START + DAY).unwrap();
        check_transfer(&t, &seller, &buyer, 1, grace_end - 1).unwrap();
        assert_eq!(code(check_transfer(&t, &seller, &buyer, 1, grace_end)), err(PrivateLoanError::PositionNotSellable));

        // The reader swap: the seller drops out, the buyer is added, auditors stay.
        let mut t = t;
        t.auditor_hash = hash_readers(&[auditor]);
        let readers = current_readers(&t, vec![auditor]).unwrap();
        t.current_lender = buyer;
        let r: Vec<Pubkey> = loan_readers(&t, &readers).iter().map(|m| m.pubkey).collect();
        assert_eq!(r, vec![buyer, borrower, auditor]);
        assert!(!r.contains(&seller));
        assert!(current_readers(&t, vec![]).is_err(), "the reader list must match the consented hash");
    }

    #[test]
    fn only_the_current_lender_sells_an_active_loan_to_a_third_party() {
        let (seller, borrower, buyer) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let mut t = terms(seller, borrower);
        let now = START + DAY;
        assert_eq!(code(check_transfer(&t, &buyer, &buyer, 1, now)), err(PrivateLoanError::NotLender));
        assert_eq!(code(check_transfer(&t, &seller, &borrower, 1, now)), err(PrivateLoanError::BuyerNotAllowed));
        assert_eq!(code(check_transfer(&t, &seller, &seller, 1, now)), err(PrivateLoanError::BuyerNotAllowed));
        assert_eq!(code(check_transfer(&t, &seller, &buyer, 0, now)), err(PrivateLoanError::ZeroAmount));
        // After a sale the old lender can no longer sell.
        t.current_lender = buyer;
        assert_eq!(code(check_transfer(&t, &seller, &Pubkey::new_unique(), 1, now)), err(PrivateLoanError::NotLender));
        // A settled loan cannot be sold.
        t.status = STATUS_REPAID;
        assert_eq!(code(check_transfer(&t, &buyer, &Pubkey::new_unique(), 1, now)), err(PrivateLoanError::WrongStatus));
    }
}
