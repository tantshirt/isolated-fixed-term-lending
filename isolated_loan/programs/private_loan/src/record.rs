//! Gate 8.3: ER-only records. Created inside the rollup, sponsored by a
//! delegated probe, private to the authority, and never committed to Solana.

use crate::constants::{PROBE_SEED, RECORD_SEED};
use crate::error::PrivateLoanError;
use crate::probe::Probe;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::CreateEphemeralPermissionCpi;
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, Member, AUTHORITY_FLAG, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::anchor::{MagicProgram, PermissionProgram};
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;

/// Raw layout: authority (32) then payload (32).
pub const RECORD_LEN: u32 = 64;

pub fn create_record(ctx: Context<CreateRecord>, payload: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    let probe_key = a.probe.key();
    let probe_seeds: &[&[u8]] = &[PROBE_SEED, &a.probe.id, core::slice::from_ref(&a.probe.bump)];
    let record_bump = [ctx.bumps.record];
    let record_seeds: &[&[u8]] = &[RECORD_SEED, probe_key.as_ref(), &record_bump];
    let probe_info = a.probe.to_account_info();
    let record_info = a.record.to_account_info();
    let vault_info = a.vault.to_account_info();

    EphemeralAccount::new(&probe_info, &record_info, &vault_info)
        .with_signer_seeds(&[probe_seeds, record_seeds])
        .create(RECORD_LEN)?;

    {
        let mut data = record_info.try_borrow_mut_data()?;
        data[..32].copy_from_slice(a.authority.key.as_ref());
        data[32..64].copy_from_slice(&payload);
    }

    CreateEphemeralPermissionCpi {
        permissioned_account: record_info.clone(),
        permission: a.record_permission.to_account_info(),
        payer: probe_info.clone(),
        vault: vault_info,
        magic_program: a.magic_program.to_account_info(),
        permission_program: a.permission_program.to_account_info(),
        args: EphemeralMembersArgs {
            is_private: true,
            members: vec![Member {
                flags: AUTHORITY_FLAG | TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG,
                pubkey: a.authority.key(),
            }],
        },
    }
    .invoke_signed(&[probe_seeds, record_seeds])?;
    Ok(())
}

#[derive(Accounts)]
pub struct CreateRecord<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ PrivateLoanError::Unauthorized)]
    pub probe: Account<'info, Probe>,
    /// CHECK: Created here by the magic program as an ER-only account.
    #[account(mut, seeds = [RECORD_SEED, probe.key().as_ref()], bump)]
    pub record: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission PDA for the record, checked by the permission program.
    #[account(mut)]
    pub record_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}
