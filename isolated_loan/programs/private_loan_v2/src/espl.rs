//! Ephemeral SPL Token instructions, built by hand.
//!
//! The SDK's `spl` feature pulls in an encryption dependency that does not
//! build for SBF. Account order follows the deployed program's processors
//! (github.com/magicblock-labs/ephemeral-spl-token, e-token/src/processor),
//! not the SDK: SDK 0.17.3 `WithdrawSplTokens` puts the owner sixth, but the
//! program reads it first and fails with MissingRequiredSignature.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

pub const ESPL_PROGRAM_ID: Pubkey = pubkey!("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");

const INITIALIZE_EPHEMERAL_ATA: u8 = 0;
const DEPOSIT_SPL_TOKENS: u8 = 2;
const WITHDRAW_SPL_TOKENS: u8 = 3;
const DELEGATE_EPHEMERAL_ATA: u8 = 4;
const UNDELEGATE_EPHEMERAL_ATA: u8 = 5;

fn call<'info>(
    data: Vec<u8>,
    metas: Vec<AccountMeta>,
    infos: &[AccountInfo<'info>],
    seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction { program_id: ESPL_PROGRAM_ID, accounts: metas, data };
    invoke_signed(&ix, infos, seeds).map_err(Into::into)
}

fn with_amount(disc: u8, amount: u64) -> Vec<u8> {
    let mut data = Vec::with_capacity(9);
    data.push(disc);
    data.extend_from_slice(&amount.to_le_bytes());
    data
}

pub fn initialize_ephemeral_ata<'info>(
    espl: &AccountInfo<'info>,
    eata: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
) -> Result<()> {
    call(
        vec![INITIALIZE_EPHEMERAL_ATA],
        vec![
            AccountMeta::new(eata.key(), false),
            AccountMeta::new(payer.key(), true),
            AccountMeta::new_readonly(owner.key(), false),
            AccountMeta::new_readonly(mint.key(), false),
            AccountMeta::new_readonly(system_program.key(), false),
        ],
        &[eata.clone(), payer.clone(), owner.clone(), mint.clone(), system_program.clone(), espl.clone()],
        &[],
    )
}

#[allow(clippy::too_many_arguments)]
pub fn deposit<'info>(
    espl: &AccountInfo<'info>,
    eata: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    vault_ata: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    call(
        with_amount(DEPOSIT_SPL_TOKENS, amount),
        vec![
            AccountMeta::new(eata.key(), false),
            AccountMeta::new_readonly(vault.key(), false),
            AccountMeta::new_readonly(mint.key(), false),
            AccountMeta::new(source.key(), false),
            AccountMeta::new(vault_ata.key(), false),
            AccountMeta::new_readonly(authority.key(), true),
            AccountMeta::new_readonly(token_program.key(), false),
        ],
        &[eata.clone(), vault.clone(), mint.clone(), source.clone(), vault_ata.clone(), authority.clone(), token_program.clone(), espl.clone()],
        seeds,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn withdraw<'info>(
    espl: &AccountInfo<'info>,
    eata: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    vault_ata: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    call(
        with_amount(WITHDRAW_SPL_TOKENS, amount),
        vec![
            AccountMeta::new_readonly(owner.key(), true),
            AccountMeta::new(eata.key(), false),
            AccountMeta::new_readonly(vault.key(), false),
            AccountMeta::new_readonly(mint.key(), false),
            AccountMeta::new(vault_ata.key(), false),
            AccountMeta::new(destination.key(), false),
            AccountMeta::new_readonly(token_program.key(), false),
        ],
        &[owner.clone(), eata.clone(), vault.clone(), mint.clone(), vault_ata.clone(), destination.clone(), token_program.clone(), espl.clone()],
        seeds,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn delegate<'info>(
    espl: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    eata: &AccountInfo<'info>,
    buffer: &AccountInfo<'info>,
    record: &AccountInfo<'info>,
    metadata: &AccountInfo<'info>,
    delegation_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    validator: Pubkey,
) -> Result<()> {
    let mut data = vec![DELEGATE_EPHEMERAL_ATA];
    data.extend_from_slice(validator.as_ref());
    call(
        data,
        vec![
            AccountMeta::new(payer.key(), true),
            AccountMeta::new(eata.key(), false),
            AccountMeta::new_readonly(espl.key(), false),
            AccountMeta::new(buffer.key(), false),
            AccountMeta::new(record.key(), false),
            AccountMeta::new(metadata.key(), false),
            AccountMeta::new_readonly(delegation_program.key(), false),
            AccountMeta::new_readonly(system_program.key(), false),
        ],
        &[payer.clone(), eata.clone(), espl.clone(), buffer.clone(), record.clone(), metadata.clone(), delegation_program.clone(), system_program.clone()],
        &[],
    )
}

pub fn undelegate<'info>(
    espl: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    owner_ata: &AccountInfo<'info>,
    eata: &AccountInfo<'info>,
    magic_context: &AccountInfo<'info>,
    magic_program: &AccountInfo<'info>,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    call(
        vec![UNDELEGATE_EPHEMERAL_ATA],
        vec![
            AccountMeta::new_readonly(owner.key(), true),
            AccountMeta::new(owner_ata.key(), false),
            AccountMeta::new_readonly(eata.key(), false),
            AccountMeta::new(magic_context.key(), false),
            AccountMeta::new_readonly(magic_program.key(), false),
        ],
        &[owner.clone(), owner_ata.clone(), eata.clone(), magic_context.clone(), magic_program.clone(), espl.clone()],
        seeds,
    )
}
