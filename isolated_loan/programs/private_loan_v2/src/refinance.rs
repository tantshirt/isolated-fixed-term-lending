//! Refinance and rollover for private V2 loans (Story 26.1, research.md § Refinance and rollover).
//!
//! Runs in the ephemeral rollup, inside one rollup domain: the old loan (Active) and the new one
//! (Funded, proposed to this borrower) are both delegated there, so their ER-only `LoanTerms`
//! never reach the base layer. The borrower signs with fresh consent to the new terms: the exact
//! revision and the auditor audience they were shown. Nothing refinances without that signature.

use crate::constants::LOAN_TERMS_SEED;
use crate::error::{core_error, PrivateLoanError};
use crate::loan::{
    check_origination, loan_signer, require_ata, transfer, LoanAnchor, LoanTerms, OriginationAccounts, STATUS_ACTIVE, STATUS_FUNDED,
    STATUS_REFINANCED,
};
use crate::room::{load, store};
use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use ephemeral_rollups_sdk::anchor::{MagicProgram, PermissionProgram};
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use loan_core::accounting::{self as acc, Phase};

/// The old loan's lender receives exactly its payoff: the new principal from the new loan's
/// custody plus the borrower's contribution. Collateral moves custody to custody; the new loan
/// locks exactly its required amount (any excess returns, any gap comes from the borrower). The
/// old loan ends `Refinanced`, never `Repaid`. `max_contribution` bounds what the borrower pays.
pub fn refinance(ctx: Context<Refinance>, revision: u32, auditor_hash: [u8; 32], max_contribution: u64) -> Result<()> {
    let a = &ctx.accounts;
    let borrower = a.borrower.key();
    let (old_info, new_info) = (a.old_terms.to_account_info(), a.new_terms.to_account_info());
    let mut old: LoanTerms = load(&old_info)?;
    let mut new: LoanTerms = load(&new_info)?;
    require_keys_eq!(old.borrower, borrower, PrivateLoanError::NotBorrower);
    require!(old.status == STATUS_ACTIVE, PrivateLoanError::WrongStatus);
    // The new proposal names this borrower; a renewal from the same lender is just such a proposal.
    require_keys_eq!(new.borrower, borrower, PrivateLoanError::NotBorrower);
    require!(new.status == STATUS_FUNDED, PrivateLoanError::WrongStatus);
    require!(new.revision == revision && new.funded_revision == revision, PrivateLoanError::StaleRevision);
    require!(new.auditor_hash == auditor_hash, PrivateLoanError::AuditorMismatch);
    require!(new.origin_lender != borrower && new.current_lender != borrower, PrivateLoanError::InvalidTerms);
    require!(
        a.old_anchor.key() != a.new_anchor.key() && a.old_anchor.usdc_mint == a.new_anchor.usdc_mint && a.old_anchor.wsol_mint == a.new_anchor.wsol_mint,
        PrivateLoanError::RefinanceMismatch
    );
    a.check_accounts(&old)?;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let old_terms = old.core_terms()?;
    require!(matches!(acc::phase(&old_terms, now), Phase::Active | Phase::Grace), PrivateLoanError::RefinanceClosed);
    let payoff_old = old.payoff(now)?;
    let (old_ledger, paid) = acc::apply_payment(&old_terms, &old.ledger.into(), now, payoff_old).map_err(core_error)?;
    require!(paid.closed && paid.used == payoff_old, PrivateLoanError::MathOverflow);
    require!(new.principal <= payoff_old, PrivateLoanError::RefinanceCashOut);
    let contribution = payoff_old - new.principal;
    require!(contribution <= max_contribution, PrivateLoanError::PaymentAboveLimit);

    // The new loan is originated exactly as `accept_loan` does: desk policy, one accepted
    // proposal per request, and the LTV of its maximum exposure at a fresh price.
    let er = a.origination();
    let auditors = er.desk_auditors(&new)?;
    er.record_deal(&a.new_anchor, &new)?;
    let new_terms = check_origination(&mut new, &a.price_update, &clock)?;

    let required = new.collateral_required;
    let held = old.collateral_locked;
    let moved = held.min(required);
    {
        loan_signer!(a.new_anchor, nonce, seeds);
        transfer(&a.token_program, &a.new_loan_usdc, &a.old_lender_usdc, &a.new_anchor.to_account_info(), Some(&seeds), new.principal)?;
    }
    transfer(&a.token_program, &a.borrower_usdc, &a.old_lender_usdc, &a.borrower.to_account_info(), None, contribution)?;
    {
        loan_signer!(a.old_anchor, nonce, seeds);
        let signer = a.old_anchor.to_account_info();
        transfer(&a.token_program, &a.old_loan_wsol, &a.new_loan_wsol, &signer, Some(&seeds), moved)?;
        transfer(&a.token_program, &a.old_loan_wsol, &a.borrower_wsol, &signer, Some(&seeds), held - moved)?;
    }
    transfer(&a.token_program, &a.borrower_wsol, &a.new_loan_wsol, &a.borrower.to_account_info(), None, required - moved)?;

    old.ledger = old_ledger.into();
    old.settle(STATUS_REFINANCED, now);
    store(&old_info, &old)?;

    new.ledger = acc::open(&new_terms).map_err(core_error)?.into();
    new.collateral_locked = required;
    new.status = STATUS_ACTIVE;
    new.accepted_revision = revision;
    er.grant_auditors(&a.new_anchor, &new_info, &new, &auditors)?;
    store(&new_info, &new)
}

#[derive(Accounts)]
pub struct Refinance<'info> {
    pub borrower: Signer<'info>,
    pub old_anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms` of the loan being refinanced.
    #[account(mut, seeds = [LOAN_TERMS_SEED, old_anchor.key().as_ref()], bump)]
    pub old_terms: UncheckedAccount<'info>,
    /// CHECK: Old loan's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub old_loan_wsol: UncheckedAccount<'info>,
    /// CHECK: Old loan's current lender's USDC ATA (receives the payoff); checked in the handler.
    #[account(mut)]
    pub old_lender_usdc: UncheckedAccount<'info>,
    /// Writable: on first acceptance of its request it pays rent for the room deal record.
    #[account(mut)]
    pub new_anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms` of the funded proposal.
    #[account(mut, seeds = [LOAN_TERMS_SEED, new_anchor.key().as_ref()], bump)]
    pub new_terms: UncheckedAccount<'info>,
    /// CHECK: New loan's USDC ATA (holds the funded principal); checked in the handler.
    #[account(mut)]
    pub new_loan_usdc: UncheckedAccount<'info>,
    /// CHECK: New loan's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub new_loan_wsol: UncheckedAccount<'info>,
    /// CHECK: Borrower's USDC ATA; checked in the handler.
    #[account(mut)]
    pub borrower_usdc: UncheckedAccount<'info>,
    /// CHECK: Borrower's wSOL ATA; checked in the handler.
    #[account(mut)]
    pub borrower_wsol: UncheckedAccount<'info>,
    /// CHECK: Canonical Pyth receiver account; owner, feed, age, confidence, and exponent checked by loan-core.
    pub price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: ER-only deal record for the new proposal's borrowing request; address checked in the handler.
    #[account(mut)]
    pub deal: Option<UncheckedAccount<'info>>,
    /// CHECK: Ephemeral permission for `deal` (first acceptance of the request only).
    #[account(mut)]
    pub deal_permission: Option<UncheckedAccount<'info>>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: Option<UncheckedAccount<'info>>,
    pub magic_program: Option<Program<'info, MagicProgram>>,
    pub permission_program: Option<Program<'info, PermissionProgram>>,
    /// CHECK: The new loan's terms permission (desk loans with auditors).
    #[account(mut)]
    pub terms_permission: Option<UncheckedAccount<'info>>,
    /// CHECK: The new loan's pinned `DeskPolicy` (desk loans); address checked in the handler.
    pub desk_policy: Option<UncheckedAccount<'info>>,
}

impl<'info> Refinance<'info> {
    fn origination(&self) -> OriginationAccounts<'_, 'info> {
        OriginationAccounts {
            deal: self.deal.as_ref(),
            deal_permission: self.deal_permission.as_ref(),
            vault: self.vault.as_ref(),
            magic_program: self.magic_program.as_ref(),
            permission_program: self.permission_program.as_ref(),
            terms_permission: self.terms_permission.as_ref(),
            desk_policy: self.desk_policy.as_ref(),
        }
    }

    fn check_accounts(&self, old: &LoanTerms) -> Result<()> {
        let (usdc, wsol) = (self.old_anchor.usdc_mint, self.old_anchor.wsol_mint);
        let (old_loan, new_loan) = (self.old_anchor.key(), self.new_anchor.key());
        require_ata(&self.old_loan_wsol, &old_loan, &wsol)?;
        require_ata(&self.old_lender_usdc, &old.current_lender, &usdc)?;
        require_ata(&self.new_loan_usdc, &new_loan, &usdc)?;
        require_ata(&self.new_loan_wsol, &new_loan, &wsol)?;
        require_ata(&self.borrower_usdc, &old.borrower, &usdc)?;
        require_ata(&self.borrower_wsol, &old.borrower, &wsol)
    }
}
