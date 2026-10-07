//! ZenLo credit tier MXE (Story 27.1, docs/architecture.md § Arcium credit tier).
//!
//! An Arcium MXE that computes a borrower's credit tier (0–3) from inputs it reads itself:
//!
//! - **Repayment counts** only from the borrower's `HistoryAttestation` at
//!   `["credit-attestation", borrower]`, owned by `private_loan_v2` and written there only by the
//!   rollup's post-commit action (`credit_tier::check_history`): right owner, right PDA, right
//!   discriminator and version, the borrower named inside, attested at least once, and attested at
//!   most 30 days ago. Nothing the caller passes as an argument reaches the circuit.
//! - **Income band** only from the borrower's valid SAS credit credential, checked by
//!   `isolated_loan_v2::credit::sas_credential` against `isolated_loan_v2`'s `Config` and
//!   `CreditConfig` (issuer, credential, schema, subject, both expiries). The band is the
//!   credential's tier (`app/lib/credit/bands.ts`), so an MXE tier never exceeds it.
//!
//! The circuit `tier` (`encrypted-ixs`) applies the rule in research.md § Arcium credit tier and
//! reveals only `tier: u8`. `tier_callback` writes `TierResult` at `["arcium-tier", borrower]`,
//! which `isolated_loan_v2` accepts in place of an SAS credential.
//!
//! Inputs are passed to the circuit as plaintext because they are read from public accounts: the
//! borrower chose to publish the counts, and the SAS tier byte is public. The MPC adds no input
//! privacy today; see the architecture note for the follow-up that encrypts the attestation.

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;
use credit_tier::{check_history, HistoryError, TIER_RESULT_SEED, TIER_RESULT_VERSION};

const COMP_DEF_OFFSET_TIER: u32 = comp_def_offset("tier");

declare_id!("828JKMx1RDffwUtWAKQ7gwyFwWEBrxoWQ5UnnJ9Upreb");

#[arcium_program]
pub mod zenlo_credit_mxe {
    use super::*;

    /// Registers the `tier` circuit with Arcium. Once, after deployment.
    pub fn init_comp_def(ctx: Context<InitTierCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    /// Queues the tier computation for the signing borrower. The counts are read from the
    /// borrower's `HistoryAttestation`, the income band from their SAS credential; no count or band
    /// is an argument.
    pub fn request_tier(ctx: Context<RequestTier>, computation_offset: u64) -> Result<()> {
        let clock = Clock::get()?;
        let borrower = ctx.accounts.borrower.key();

        let h = &ctx.accounts.history_attestation;
        let counts = {
            let data = h.try_borrow_data()?;
            check_history(h.owner, h.key, h.lamports(), &data, &borrower, clock.unix_timestamp).map_err(history_error)?
        };

        let credit_accounts = [
            ctx.accounts.loan_config.to_account_info(),
            ctx.accounts.credit_config.to_account_info(),
            ctx.accounts.sas_attestation.to_account_info(),
        ];
        let (income_band, income_valid_until) =
            isolated_loan_v2::credit::sas_credential(&credit_accounts, &borrower, clock.unix_timestamp).ok_or(CreditMxeError::IncomeCredentialRequired)?;

        let bump = ctx.bumps.tier_result;
        let r = &mut ctx.accounts.tier_result;
        if r.version == 0 {
            r.version = TIER_RESULT_VERSION;
            r.borrower = borrower;
            r.bump = bump;
        }
        require!(r.version == TIER_RESULT_VERSION && r.borrower == borrower, CreditMxeError::TierResultMismatch);
        // An older attestation never replaces the one a previous computation used.
        require!(counts.rollup_slot >= r.attestation_slot, CreditMxeError::AttestationStale);
        r.pending = true;
        r.pending_offset = computation_offset;
        r.pending_attestation_slot = counts.rollup_slot;
        r.pending_attested_at = counts.attested_at;
        r.pending_income_valid_until = income_valid_until;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = ArgBuilder::new()
            .plaintext_u32(counts.on_time)
            .plaintext_u32(counts.late)
            .plaintext_u32(counts.liquidated)
            .plaintext_u32(counts.defaulted)
            .plaintext_u8(income_band)
            .build();
        let tier_result = ctx.accounts.tier_result.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![TierCallback::callback_ix(computation_offset, &ctx.accounts.mxe_account, &[CallbackAccount { pubkey: tier_result, is_writable: true }])?],
            1,
            0,
            0,
        )?;
        emit!(TierRequested { borrower, attestation_slot: counts.rollup_slot, computation_offset });
        Ok(())
    }

    /// Writes the revealed tier. Only the callback of the borrower's latest request writes; an
    /// older computation that finishes late changes nothing.
    #[arcium_callback(encrypted_ix = "tier")]
    pub fn tier_callback(ctx: Context<TierCallback>, output: SignedComputationOutputs<TierOutput>) -> Result<()> {
        let tier = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(TierOutput { field_0 }) => field_0,
            Err(_) => return Err(CreditMxeError::AbortedComputation.into()),
        };
        let r = &mut ctx.accounts.tier_result;
        let expected = derive_comp_pda!(r.pending_offset, ctx.accounts.mxe_account);
        if !r.pending || ctx.accounts.computation_account.key() != expected {
            msg!("Superseded computation; TierResult unchanged");
            return Ok(());
        }
        let clock = Clock::get()?;
        r.tier = tier.min(3);
        r.computed_slot = clock.slot;
        r.computed_at = clock.unix_timestamp;
        r.attestation_slot = r.pending_attestation_slot;
        r.attested_at = r.pending_attested_at;
        r.income_valid_until = r.pending_income_valid_until;
        r.pending = false;
        emit!(TierComputed { borrower: r.borrower, tier: r.tier, attestation_slot: r.attestation_slot });
        Ok(())
    }
}

fn history_error(e: HistoryError) -> Error {
    match e {
        HistoryError::Missing => error!(CreditMxeError::AttestationMissing),
        HistoryError::WrongOwner => error!(CreditMxeError::AttestationWrongOwner),
        HistoryError::WrongAddress | HistoryError::Malformed | HistoryError::WrongBorrower => error!(CreditMxeError::AttestationMismatch),
        HistoryError::NotAttested => error!(CreditMxeError::AttestationNotWritten),
        HistoryError::Stale => error!(CreditMxeError::AttestationStale),
    }
}

/// The latest tier for a borrower. `isolated_loan_v2` reads it by the offsets in
/// `credit_tier::tier_offsets`; keep the field order.
#[account]
#[derive(InitSpace)]
pub struct TierResult {
    pub version: u8,
    pub borrower: Pubkey,
    /// 0–3. 0 until the first callback.
    pub tier: u8,
    /// Base-layer slot and time of the callback that wrote `tier`.
    pub computed_slot: u64,
    pub computed_at: i64,
    /// `rollup_slot` and `attested_at` of the `HistoryAttestation` the tier was computed from.
    pub attestation_slot: u64,
    pub attested_at: i64,
    /// When the SAS credential that supplied the income band stops being valid.
    pub income_valid_until: i64,
    /// A request is queued and its callback has not run.
    pub pending: bool,
    pub pending_offset: u64,
    pub pending_attestation_slot: u64,
    pub pending_attested_at: i64,
    pub pending_income_valid_until: i64,
    pub bump: u8,
    pub reserved: [u8; 32],
}

#[queue_computation_accounts("tier", borrower)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct RequestTier<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,
    /// CHECK: The borrower's `private_loan_v2` `HistoryAttestation`; every check is in
    /// `credit_tier::check_history` (owner, PDA, discriminator, version, borrower, freshness).
    pub history_attestation: UncheckedAccount<'info>,
    /// CHECK: `isolated_loan_v2` `Config`; owner and PDA checked by `sas_credential`.
    pub loan_config: UncheckedAccount<'info>,
    /// CHECK: `isolated_loan_v2` `CreditConfig`; owner and PDA checked by `sas_credential`.
    pub credit_config: UncheckedAccount<'info>,
    /// CHECK: The borrower's SAS credit credential; checked by `sas_credential`.
    pub sas_attestation: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = borrower,
        space = 8 + TierResult::INIT_SPACE,
        seeds = [TIER_RESULT_SEED, borrower.key().as_ref()],
        bump,
    )]
    pub tier_result: Box<Account<'info, TierResult>>,
    #[account(init_if_needed, space = 9, payer = borrower, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_TIER))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("tier")]
#[derive(Accounts)]
pub struct TierCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_TIER))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: address is validated by the Arcium program; verify_output reads slot data from it.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, seeds = [TIER_RESULT_SEED, tier_result.borrower.as_ref()], bump = tier_result.bump)]
    pub tier_result: Box<Account<'info, TierResult>>,
}

#[init_computation_definition_accounts("tier", payer)]
#[derive(Accounts)]
pub struct InitTierCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program. Not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct TierRequested {
    pub borrower: Pubkey,
    pub attestation_slot: u64,
    pub computation_offset: u64,
}

/// Only the tier is published; no counts and no band.
#[event]
pub struct TierComputed {
    pub borrower: Pubkey,
    pub tier: u8,
    pub attestation_slot: u64,
}

#[error_code]
pub enum CreditMxeError {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("The borrower has no history attestation")]
    AttestationMissing,
    #[msg("The history attestation is not owned by private_loan_v2")]
    AttestationWrongOwner,
    #[msg("The history attestation is not this borrower's, or is malformed")]
    AttestationMismatch,
    #[msg("The history attestation was opened but never written by the rollup")]
    AttestationNotWritten,
    #[msg("The history attestation is stale or older than the last one used")]
    AttestationStale,
    #[msg("The income band needs a valid SAS credit credential")]
    IncomeCredentialRequired,
    #[msg("TierResult does not belong to this borrower")]
    TierResultMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_matches_credit_tier_crate() {
        use credit_tier::tier_offsets::*;
        assert_eq!(TierResult::DISCRIMINATOR, credit_tier::TIER_RESULT_DISCRIMINATOR);
        assert_eq!(8 + TierResult::INIT_SPACE, credit_tier::TIER_RESULT_LEN);
        let borrower = Pubkey::new_unique();
        let r = TierResult {
            version: 1,
            borrower,
            tier: 2,
            computed_slot: 11,
            computed_at: 12,
            attestation_slot: 13,
            attested_at: 14,
            income_valid_until: 15,
            pending: true,
            pending_offset: 16,
            pending_attestation_slot: 17,
            pending_attested_at: 18,
            pending_income_valid_until: 19,
            bump: 20,
            reserved: [0; 32],
        };
        let mut data = Vec::new();
        r.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), credit_tier::TIER_RESULT_LEN);
        let at = |o: usize| i64::from_le_bytes(data[o..o + 8].try_into().unwrap());
        assert_eq!(data[VERSION], 1);
        assert_eq!(&data[BORROWER..BORROWER + 32], borrower.as_ref());
        assert_eq!(data[TIER], 2);
        assert_eq!((at(COMPUTED_SLOT), at(COMPUTED_AT), at(ATTESTATION_SLOT), at(ATTESTED_AT), at(INCOME_VALID_UNTIL)), (11, 12, 13, 14, 15));
    }
}
