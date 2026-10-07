//! Private automation mandates (Story 26.3).
//!
//! The same bounds as `isolated_loan_v2` (`loan_core::mandate`), evaluated inside the rollup by
//! a signer-free Hydra crank (`run_mandate`), never in Convex or any server. The record is
//! ER-only and readable only by the borrower. There is no keeper, so there is no keeper fee:
//! `fee_per_exec` and `fee_cap` are zero. A health trigger re-arms in the crank itself once the
//! conservative spot LTV is at least 200 bps below it. Every condition that does not hold makes
//! a run do nothing, so the crank is harmless to repeat; nothing ever moves after settlement,
//! after expiry, after revocation, or without the borrower's live SPL delegation.
//!
//! A repay mandate is bound to the current lender's USDC account when it is created. If the
//! position is later sold, its runs do nothing until the borrower creates a new mandate.

use crate::constants::{LOAN_SEED, LOAN_TERMS_SEED};
use crate::error::{core_error, PrivateLoanError};
use crate::loan::{create_loan_record, loan_signer, transfer, LoanAnchor, LoanTerms, STATUS_ACTIVE, STATUS_REPAID};
use crate::room::{load, store};
use crate::schedule::{hydra_create, HYDRA_EPHEMERAL_ID};
use crate::settle::{watch_runs, WATCH_INTERVAL_SLOTS};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Approve, Revoke, Token, TokenAccount};
use ephemeral_rollups_sdk::access_control::structs::{Member, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG};
use ephemeral_rollups_sdk::anchor::{MagicProgram, PermissionProgram};
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use loan_core::accounting as acc;
use loan_core::mandate::{self as m, Bounds};
use loan_core::math;

pub const MANDATE_SEED: &[u8] = b"mandate";

/// ER-only. Seeds `["mandate", loan anchor, action]`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrivateMandate {
    pub version: u8,
    pub borrower: Pubkey,
    pub action: u8,
    /// The borrower's ATA this mandate is the delegate of.
    pub source: Pubkey,
    /// The loan's wSOL ATA (top-up) or the current lender's USDC ATA at creation (repay).
    pub destination: Pubkey,
    pub trigger: u8,
    pub trigger_ltv_bps: u16,
    pub lead_seconds: i64,
    pub amount_per_exec: u64,
    pub cumulative_cap: u64,
    pub used: u64,
    pub expiry: i64,
    pub armed: bool,
    pub revoked: bool,
    /// Monotonic revision, advanced by executions and borrower-authorized replacements.
    pub executions: u32,
    pub last_exec_ts: i64,
    pub bump: u8,
}

impl PrivateMandate {
    pub const LEN: usize = 1 + 32 + 1 + 32 + 32 + 1 + 2 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 4 + 8 + 1;

    pub fn bounds(&self) -> Bounds {
        Bounds {
            action: self.action,
            trigger: self.trigger,
            trigger_ltv_bps: self.trigger_ltv_bps,
            lead_seconds: self.lead_seconds,
            amount_per_exec: self.amount_per_exec,
            cumulative_cap: self.cumulative_cap,
            fee_per_exec: 0,
            fee_cap: 0,
            expiry: self.expiry,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrivateMandateArgs {
    pub action: u8,
    pub trigger: u8,
    pub trigger_ltv_bps: u16,
    pub lead_seconds: i64,
    pub amount_per_exec: u64,
    pub cumulative_cap: u64,
    pub expiry: i64,
}

/// Where a mandate's tokens come from and go to, for this loan.
fn route(anchor: &LoanAnchor, anchor_key: &Pubkey, t: &LoanTerms, action: u8) -> (Pubkey, Pubkey) {
    if action == m::ACTION_TOP_UP {
        (get_associated_token_address(&t.borrower, &anchor.wsol_mint), get_associated_token_address(anchor_key, &anchor.wsol_mint))
    } else {
        (get_associated_token_address(&t.borrower, &anchor.usdc_mint), get_associated_token_address(&t.current_lender, &anchor.usdc_mint))
    }
}

/// Ephemeral rollup. The borrower creates the record, approves the mandate PDA as delegate of
/// their ATA for exactly `cumulative_cap`, and schedules the crank that evaluates it.
/// A revoked, expired or stale-lender record can be replaced by the same borrower. Replacement
/// crank seeds are SHA256("mandate-renew", mandate PDA, next execution/replacement revision LE),
/// deterministically known before signing. Account layout and initial crank seeds are unchanged.
pub fn create_private_mandate(ctx: Context<CreatePrivateMandate>, args: PrivateMandateArgs) -> Result<()> {
    let a = &ctx.accounts;
    let t: LoanTerms = load(&a.terms.to_account_info())?;
    let borrower = a.borrower.key();
    require_keys_eq!(t.borrower, borrower, PrivateLoanError::NotBorrower);
    require!(t.status == STATUS_ACTIVE, PrivateLoanError::WrongStatus);
    let now = Clock::get()?.unix_timestamp;
    let bounds = Bounds {
        action: args.action,
        trigger: args.trigger,
        trigger_ltv_bps: args.trigger_ltv_bps,
        lead_seconds: args.lead_seconds,
        amount_per_exec: args.amount_per_exec,
        cumulative_cap: args.cumulative_cap,
        fee_per_exec: 0,
        fee_cap: 0,
        expiry: args.expiry,
    };
    bounds.validate(now, t.liquidation_ltv_bps, t.duration_seconds).map_err(|_| error!(PrivateLoanError::MandateInvalid))?;
    loan_core::oracle::check_sol_usd_account(&a.price_update).map_err(core_error)?;
    let anchor_key = a.anchor.key();
    let (source, destination) = route(&a.anchor, &anchor_key, &t, args.action);
    require_keys_eq!(a.source.key(), source, PrivateLoanError::WrongTokenAccount);

    let action = [args.action];
    let (mandate_key, bump) = Pubkey::find_program_address(&[MANDATE_SEED, anchor_key.as_ref(), &action], &crate::ID);
    require_keys_eq!(a.mandate.key(), mandate_key, PrivateLoanError::InvalidRecord);
    let seen = TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG;
    let mandate_info = a.mandate.to_account_info();
    let replacement = !mandate_info.data_is_empty();
    let revision = if replacement {
        let previous: PrivateMandate = load(&mandate_info)?;
        check_address(&mandate_info, &anchor_key, &previous)?;
        check_replacement(&previous, &borrower, args.action, &destination, now)?;
        previous.executions.checked_add(1).ok_or(PrivateLoanError::MathOverflow)?
    } else {
        create_loan_record(
            &a.anchor,
            &mandate_info,
            &a.mandate_permission.to_account_info(),
            &[MANDATE_SEED, anchor_key.as_ref(), &action, &[bump]],
            PrivateMandate::LEN as u32,
            vec![Member { flags: seen, pubkey: borrower }],
            &a.vault.to_account_info(),
            &a.magic_program.to_account_info(),
            &a.permission_program.to_account_info(),
        )?;
        0
    };
    token::approve(
        CpiContext::new(a.token_program.key(), Approve { to: a.source.to_account_info(), delegate: mandate_info.clone(), authority: a.borrower.to_account_info() }),
        args.cumulative_cap,
    )?;
    let record = PrivateMandate {
        version: 1,
        borrower,
        action: args.action,
        source,
        destination,
        trigger: args.trigger,
        trigger_ltv_bps: args.trigger_ltv_bps,
        lead_seconds: args.lead_seconds,
        amount_per_exec: args.amount_per_exec,
        cumulative_cap: args.cumulative_cap,
        used: 0,
        expiry: args.expiry,
        armed: true,
        revoked: false,
        executions: revision,
        last_exec_ts: 0,
        bump,
    };
    store(&mandate_info, &record)?;

    // The crank's accounts are fixed now; optional accounts are the program id when unused.
    let repay = args.action == m::ACTION_REPAY;
    let unused = (crate::ID, false);
    let metas: Vec<(Pubkey, bool)> = vec![
        (anchor_key, false),
        (a.terms.key(), true),
        (mandate_key, true),
        (source, true),
        (destination, true),
        if repay { (get_associated_token_address(&anchor_key, &a.anchor.wsol_mint), true) } else { unused },
        if repay { (get_associated_token_address(&t.borrower, &a.anchor.wsol_mint), true) } else { unused },
        (a.price_update.key(), false),
        (anchor_spl::token::ID, false),
    ];
    let runs = watch_runs(t.duration_seconds, t.grace_seconds);
    loan_signer!(a.anchor, nonce, seeds);
    hydra_create(
        &a.anchor.to_account_info(),
        &seeds,
        &a.crank,
        &a.vault,
        &a.magic_program,
        &a.hydra_program,
        if replacement {
            // New fixed accounts and a fresh run budget. Old cranks remain harmless: runs read
            // the current bounds/delegation, and a stale destination returns without spending.
            solana_sha256_hasher::hashv(&[b"mandate-renew", mandate_key.as_ref(), &revision.to_le_bytes()]).to_bytes()
        } else {
            mandate_key.to_bytes()
        },
        anchor_key,
        WATCH_INTERVAL_SLOTS,
        runs,
        &metas,
        crate::instruction::RunMandate::DISCRIMINATOR,
    )
}

/// Only the same borrower can replace an inactive mandate. No live allowance is silently reset.
fn check_replacement(previous: &PrivateMandate, borrower: &Pubkey, action: u8, destination: &Pubkey, now: i64) -> Result<()> {
    require_keys_eq!(previous.borrower, *borrower, PrivateLoanError::NotBorrower);
    require!(previous.version == 1 && previous.action == action, PrivateLoanError::MandateInvalid);
    let stale_lender = action == m::ACTION_REPAY && previous.destination != *destination;
    require!(previous.revoked || now >= previous.expiry || stale_lender, PrivateLoanError::MandateInvalid);
    Ok(())
}

/// The record must be this loan's mandate PDA for its own action.
fn check_address(info: &AccountInfo, anchor: &Pubkey, md: &PrivateMandate) -> Result<()> {
    let expected = Pubkey::create_program_address(&[MANDATE_SEED, anchor.as_ref(), &[md.action], &[md.bump]], &crate::ID)
        .map_err(|_| error!(PrivateLoanError::InvalidRecord))?;
    require_keys_eq!(expected, info.key(), PrivateLoanError::InvalidRecord);
    Ok(())
}

/// The live SPL delegation of `source` to `mandate`, if it covers `amount`.
fn delegated(source: &AccountInfo, owner: &Pubkey, mandate: &Pubkey, amount: u64) -> bool {
    if *source.owner != anchor_spl::token::ID {
        return false;
    }
    let Ok(data) = source.try_borrow_data() else { return false };
    matches!(TokenAccount::try_deserialize(&mut &data[..]), Ok(s) if s.owner == *owner && s.delegate.contains(mandate) && s.delegated_amount >= amount)
}

/// Ephemeral rollup, signer-free (the crank). Evaluates the mandate exactly as the public
/// keeper path does, and does nothing whenever a condition fails.
pub fn run_mandate(ctx: Context<RunMandate>) -> Result<()> {
    let a = &ctx.accounts;
    let terms_info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&terms_info)?;
    let mandate_info = a.mandate.to_account_info();
    let mut md: PrivateMandate = load(&mandate_info)?;
    check_address(&mandate_info, &a.anchor.key(), &md)?;
    if t.status != STATUS_ACTIVE || md.revoked || md.version != 1 {
        return Ok(());
    }
    require_keys_eq!(a.source.key(), md.source, PrivateLoanError::WrongTokenAccount);
    // A replaced mandate may have a new lender; earlier cranks retain the old destination.
    if a.destination.key() != md.destination {
        return Ok(());
    }
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let bounds = md.bounds();
    let terms = t.core_terms()?;

    let ltv = if md.trigger == m::TRIGGER_HEALTH {
        // A stale or invalid price means no decision this round.
        let Ok(p) = loan_core::oracle::read_sol_usd_price(&a.price_update, &clock) else { return Ok(()) };
        let value = math::collateral_value_usdc(t.collateral_locked, p.price, p.conf, p.exponent).map_err(core_error)?;
        Some(math::current_ltv_bps(t.payoff(now)?, value).map_err(core_error)?)
    } else {
        None
    };
    if !md.armed {
        if matches!(ltv, Some(l) if m::may_rearm(&bounds, md.armed, l)) && now < md.expiry {
            md.armed = true;
            store(&mandate_info, &md)?;
        }
        return Ok(());
    }
    if m::fires(&bounds, md.armed, now, terms.maturity(), ltv).is_err() {
        return Ok(());
    }
    let payoff = if md.action == m::ACTION_REPAY { Some(t.payoff(now)?) } else { None };
    let Ok(plan) = m::plan(&bounds, md.used, 0, 0, payoff) else { return Ok(()) };
    if !delegated(&a.source, &md.borrower, &mandate_info.key(), plan.amount) {
        return Ok(());
    }
    let anchor_key = a.anchor.key();
    let action = [md.action];
    let bump = [md.bump];
    let mseeds: [&[u8]; 4] = [MANDATE_SEED, anchor_key.as_ref(), &action, &bump];
    let source = a.source.to_account_info();
    let destination = a.destination.to_account_info();

    let moved = if md.action == m::ACTION_TOP_UP {
        require_keys_eq!(md.destination, get_associated_token_address(&anchor_key, &a.anchor.wsol_mint), PrivateLoanError::WrongTokenAccount);
        transfer(&a.token_program, &source, &destination, &mandate_info, Some(&mseeds), plan.amount)?;
        t.collateral_locked = t.collateral_locked.checked_add(plan.amount).ok_or(PrivateLoanError::MathOverflow)?;
        plan.amount
    } else {
        // Bound to the lender at creation: after a sale this mandate does nothing.
        if md.destination != get_associated_token_address(&t.current_lender, &a.anchor.usdc_mint) {
            return Ok(());
        }
        let (ledger, p) = acc::apply_payment(&terms, &t.ledger.into(), now, plan.amount).map_err(core_error)?;
        transfer(&a.token_program, &source, &destination, &mandate_info, Some(&mseeds), p.used)?;
        t.ledger = ledger.into();
        if p.closed {
            let loan_wsol = a.loan_wsol.as_ref().ok_or(PrivateLoanError::WrongTokenAccount)?;
            let borrower_wsol = a.borrower_wsol.as_ref().ok_or(PrivateLoanError::WrongTokenAccount)?;
            require_keys_eq!(loan_wsol.key(), get_associated_token_address(&anchor_key, &a.anchor.wsol_mint), PrivateLoanError::WrongTokenAccount);
            require_keys_eq!(borrower_wsol.key(), get_associated_token_address(&t.borrower, &a.anchor.wsol_mint), PrivateLoanError::WrongTokenAccount);
            loan_signer!(a.anchor, nonce, seeds);
            transfer(&a.token_program, &loan_wsol.to_account_info(), &borrower_wsol.to_account_info(), &a.anchor.to_account_info(), Some(&seeds), t.collateral_locked)?;
            t.settle(STATUS_REPAID, now);
        }
        p.used
    };
    // Any ledger or collateral change makes an open liquidation quote stale.
    t.ledger_revision = t.ledger_revision.saturating_add(1);
    store(&terms_info, &t)?;
    md.used = md.used.checked_add(moved).ok_or(PrivateLoanError::MathOverflow)?;
    md.armed = false;
    md.executions = md.executions.saturating_add(1);
    md.last_exec_ts = now;
    store(&mandate_info, &md)
}

/// Ephemeral rollup. The borrower stops the mandate at once and revokes the delegate if it is
/// still this mandate's. Works in any loan status.
pub fn revoke_private_mandate(ctx: Context<RevokePrivateMandate>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.mandate.to_account_info();
    let mut md: PrivateMandate = load(&info)?;
    check_address(&info, &a.anchor.key(), &md)?;
    require_keys_eq!(md.borrower, a.borrower.key(), PrivateLoanError::NotBorrower);
    require_keys_eq!(a.source.key(), md.source, PrivateLoanError::WrongTokenAccount);
    md.revoked = true;
    store(&info, &md)?;
    if delegated(&a.source, &md.borrower, &info.key(), 0) {
        token::revoke(CpiContext::new(a.token_program.key(), Revoke { source: a.source.to_account_info(), authority: a.borrower.to_account_info() }))?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct CreatePrivateMandate<'info> {
    pub borrower: Signer<'info>,
    /// Pays the record's rent and sponsors the crank.
    #[account(mut, seeds = [LOAN_SEED, anchor.creator.as_ref(), &anchor.nonce.to_le_bytes()], bump = anchor.bump)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: ER-only `PrivateMandate`, created here; address checked in the handler.
    #[account(mut)]
    pub mandate: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `mandate`.
    #[account(mut)]
    pub mandate_permission: UncheckedAccount<'info>,
    /// CHECK: The borrower's ATA for the action's asset; checked in the handler.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: Canonical Pyth SOL/USD account named in the crank; owner and feed checked here.
    pub price_update: UncheckedAccount<'info>,
    /// CHECK: Crank PDA, checked by Hydra.
    #[account(mut)]
    pub crank: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
    /// CHECK: Fixed Hydra ephemeral program id.
    #[account(address = HYDRA_EPHEMERAL_ID)]
    pub hydra_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RunMandate<'info> {
    #[account(seeds = [LOAN_SEED, anchor.creator.as_ref(), &anchor.nonce.to_le_bytes()], bump = anchor.bump)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(mut, seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: ER-only `PrivateMandate`; owner checked by `load`, address by `check_address`.
    #[account(mut)]
    pub mandate: UncheckedAccount<'info>,
    /// CHECK: The borrower's ATA named in the record.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: The loan's wSOL ATA or the lender's USDC ATA named in the record.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: Repay only: the loan's wSOL ATA, for a closing payment; checked in the handler.
    #[account(mut)]
    pub loan_wsol: Option<UncheckedAccount<'info>>,
    /// CHECK: Repay only: the borrower's wSOL ATA, for a closing payment; checked in the handler.
    #[account(mut)]
    pub borrower_wsol: Option<UncheckedAccount<'info>>,
    /// CHECK: Canonical Pyth SOL/USD; checked by loan-core when a health trigger reads it.
    pub price_update: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RevokePrivateMandate<'info> {
    pub borrower: Signer<'info>,
    #[account(seeds = [LOAN_SEED, anchor.creator.as_ref(), &anchor.nonce.to_le_bytes()], bump = anchor.bump)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `PrivateMandate`; owner checked by `load`, address by `check_address`.
    #[account(mut)]
    pub mandate: UncheckedAccount<'info>,
    /// CHECK: The borrower's ATA named in the record.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacements_require_the_same_borrower_and_an_inactive_or_stale_mandate() {
        let borrower = Pubkey::new_unique();
        let destination = Pubkey::new_unique();
        let mut md = PrivateMandate {
            version: 1, borrower, action: m::ACTION_REPAY, source: Pubkey::new_unique(), destination,
            trigger: m::TRIGGER_HEALTH, trigger_ltv_bps: 7_000, lead_seconds: 0, amount_per_exec: 1,
            cumulative_cap: 2, used: 0, expiry: 100, armed: true, revoked: false, executions: 0,
            last_exec_ts: 0, bump: 255,
        };
        assert!(check_replacement(&md, &borrower, m::ACTION_REPAY, &destination, 99).is_err());
        assert!(check_replacement(&md, &borrower, m::ACTION_REPAY, &destination, 100).is_ok());
        assert!(check_replacement(&md, &borrower, m::ACTION_REPAY, &Pubkey::new_unique(), 99).is_ok());
        md.revoked = true;
        assert!(check_replacement(&md, &borrower, m::ACTION_REPAY, &destination, 99).is_ok());
        assert!(check_replacement(&md, &Pubkey::new_unique(), m::ACTION_REPAY, &destination, 100).is_err());
        assert!(check_replacement(&md, &borrower, m::ACTION_TOP_UP, &destination, 100).is_err());
        md.revoked = false;
        md.action = m::ACTION_TOP_UP;
        assert!(check_replacement(&md, &borrower, m::ACTION_TOP_UP, &Pubkey::new_unique(), 99).is_err());
    }

    #[test]
    fn record_length_matches_its_fields() {
        let r = PrivateMandate {
            version: 1, borrower: Pubkey::new_unique(), action: 1, source: Pubkey::new_unique(), destination: Pubkey::new_unique(),
            trigger: 0, trigger_ltv_bps: 7_000, lead_seconds: 0, amount_per_exec: 1, cumulative_cap: 2, used: 0, expiry: 9,
            armed: true, revoked: false, executions: 0, last_exec_ts: 0, bump: 255,
        };
        let mut data = Vec::new();
        r.serialize(&mut data).unwrap();
        assert_eq!(data.len(), PrivateMandate::LEN);
    }
}
