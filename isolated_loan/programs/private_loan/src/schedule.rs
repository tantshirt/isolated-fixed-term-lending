//! Gate 8.6: Hydra crank created inside the ER, sponsored by a delegated probe.
//! The wire format mirrors hydra-api 0.2.1 `CreateArgs::write_to`.

use crate::constants::PROBE_SEED;
use crate::error::PrivateLoanError;
use crate::probe::Probe;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use ephemeral_rollups_sdk::anchor::MagicProgram;
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;

pub const HYDRA_EPHEMERAL_ID: Pubkey = pubkey!("eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf");
const HYDRA_CREATE: u8 = 0;
const META_WRITABLE: u8 = 0b10;

/// Schedules `crank_tick` on this probe every `interval_slots`, `remaining` times.
/// The scheduled instruction names only the probe address and a discriminator.
pub fn schedule_tick(ctx: Context<ScheduleTick>, seed: [u8; 32], interval_slots: u64, remaining: u64) -> Result<()> {
    let a = &ctx.accounts;
    let tick = crate::instruction::CrankTick::DISCRIMINATOR;

    let mut data = Vec::with_capacity(1 + 100 + 35 + 33 + tick.len());
    data.push(HYDRA_CREATE);
    data.extend_from_slice(&seed);
    data.extend_from_slice(a.authority.key.as_ref()); // cancel authority
    data.extend_from_slice(&0u64.to_le_bytes()); // start now
    data.extend_from_slice(&interval_slots.to_le_bytes());
    data.extend_from_slice(&remaining.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes()); // priority tip
    data.extend_from_slice(&0u32.to_le_bytes()); // cu limit: default
    data.push(1); // one meta
    data.extend_from_slice(&(tick.len() as u16).to_le_bytes());
    data.extend_from_slice(crate::ID.as_ref());
    data.push(META_WRITABLE);
    data.extend_from_slice(a.probe.key().as_ref());
    data.extend_from_slice(tick);

    let ix = Instruction {
        program_id: HYDRA_EPHEMERAL_ID,
        accounts: vec![
            AccountMeta::new(a.probe.key(), true),
            AccountMeta::new(a.crank.key(), false),
            AccountMeta::new(a.vault.key(), false),
            AccountMeta::new_readonly(a.magic_program.key(), false),
        ],
        data,
    };
    let probe_seeds: &[&[u8]] = &[PROBE_SEED, &a.probe.id, core::slice::from_ref(&a.probe.bump)];
    invoke_signed(
        &ix,
        &[
            a.probe.to_account_info(),
            a.crank.to_account_info(),
            a.vault.to_account_info(),
            a.magic_program.to_account_info(),
            a.hydra_program.to_account_info(),
        ],
        &[probe_seeds],
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct ScheduleTick<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ PrivateLoanError::Unauthorized)]
    pub probe: Account<'info, Probe>,
    /// CHECK: Crank PDA, derived and checked by Hydra.
    #[account(mut)]
    pub crank: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    /// CHECK: Fixed Hydra ephemeral program id.
    #[account(address = HYDRA_EPHEMERAL_ID)]
    pub hydra_program: UncheckedAccount<'info>,
}
