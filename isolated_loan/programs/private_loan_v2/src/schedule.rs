//! Hydra cranks created inside the ER (gate 8.6), used by the settlement watch.
//! The wire format mirrors hydra-api 0.2.1 `CreateArgs::write_to`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use ephemeral_rollups_sdk::anchor::MagicProgram;

pub const HYDRA_EPHEMERAL_ID: Pubkey = pubkey!("eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf");
const HYDRA_CREATE: u8 = 0;
const META_WRITABLE: u8 = 0b10;

/// Creates a Hydra crank inside the ER. `sponsor` (a delegated PDA) pays rent
/// and signs with `sponsor_seeds`; it is also the cancel authority.
#[allow(clippy::too_many_arguments)]
pub fn hydra_create<'info>(
    sponsor: &AccountInfo<'info>,
    sponsor_seeds: &[&[u8]],
    crank: &UncheckedAccount<'info>,
    vault: &UncheckedAccount<'info>,
    magic_program: &Program<'info, MagicProgram>,
    hydra_program: &UncheckedAccount<'info>,
    seed: [u8; 32],
    cancel_authority: Pubkey,
    interval_slots: u64,
    remaining: u64,
    metas: &[(Pubkey, bool)],
    data: &[u8],
) -> Result<()> {
    let mut body = Vec::with_capacity(1 + 100 + 35 + 33 * metas.len() + data.len());
    body.push(HYDRA_CREATE);
    body.extend_from_slice(&seed);
    body.extend_from_slice(cancel_authority.as_ref());
    body.extend_from_slice(&0u64.to_le_bytes());
    body.extend_from_slice(&interval_slots.to_le_bytes());
    body.extend_from_slice(&remaining.to_le_bytes());
    body.extend_from_slice(&0u64.to_le_bytes());
    body.extend_from_slice(&400_000u32.to_le_bytes()); // room for price checks and transfers
    body.push(metas.len() as u8);
    body.extend_from_slice(&(data.len() as u16).to_le_bytes());
    body.extend_from_slice(crate::ID.as_ref());
    for (k, w) in metas {
        body.push(if *w { META_WRITABLE } else { 0 });
        body.extend_from_slice(k.as_ref());
    }
    body.extend_from_slice(data);
    let ix = Instruction {
        program_id: HYDRA_EPHEMERAL_ID,
        accounts: vec![
            AccountMeta::new(sponsor.key(), true),
            AccountMeta::new(crank.key(), false),
            AccountMeta::new(vault.key(), false),
            AccountMeta::new_readonly(magic_program.key(), false),
        ],
        data: body,
    };
    invoke_signed(
        &ix,
        &[sponsor.clone(), crank.to_account_info(), vault.to_account_info(), magic_program.to_account_info(), hydra_program.to_account_info()],
        &[sponsor_seeds],
    )?;
    Ok(())
}
