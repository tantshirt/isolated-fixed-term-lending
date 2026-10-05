use crate::constants::{PROBE_SEED, TEE_VALIDATOR};
use crate::error::{core_error, PrivateLoanError};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::{
    CreatePermissionCpi, CreatePermissionCpiAccounts, CreatePermissionInstructionArgs,
    DelegatePermissionCpiBuilder,
};
use ephemeral_rollups_sdk::access_control::structs::{
    Member, MembersArgs, AUTHORITY_FLAG, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::anchor::{commit, delegate, PermissionProgram};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

#[account]
#[derive(InitSpace)]
pub struct Probe {
    pub id: [u8; 32],
    pub authority: Pubkey,
    pub value: u64,
    pub price: i64,
    pub price_exponent: i32,
    pub bump: u8,
}

pub fn create_probe(ctx: Context<CreateProbe>, id: [u8; 32], reader: Pubkey) -> Result<()> {
    let probe = &mut ctx.accounts.probe;
    probe.id = id;
    probe.authority = ctx.accounts.authority.key();
    probe.bump = ctx.bumps.probe;

    let seen = TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG;
    let members = vec![
        Member { flags: AUTHORITY_FLAG | seen, pubkey: ctx.accounts.authority.key() },
        Member { flags: seen, pubkey: reader },
    ];
    let seeds: &[&[u8]] = &[PROBE_SEED, &id, &[ctx.bumps.probe]];
    CreatePermissionCpi::new(
        &ctx.accounts.permission_program.to_account_info(),
        CreatePermissionCpiAccounts {
            permissioned_account: &ctx.accounts.probe.to_account_info(),
            permission: &ctx.accounts.permission.to_account_info(),
            payer: &ctx.accounts.authority.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
        },
        CreatePermissionInstructionArgs { args: MembersArgs { members: Some(members) } },
    )
    .invoke_signed(&[seeds])?;
    Ok(())
}

pub fn delegate_probe(ctx: Context<DelegateProbe>, id: [u8; 32]) -> Result<()> {
    let (_, bump) = Pubkey::find_program_address(&[PROBE_SEED, &id], &crate::ID);
    let seeds: &[&[u8]] = &[PROBE_SEED, &id, &[bump]];

    DelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
        .payer(&ctx.accounts.authority.to_account_info())
        .authority(&ctx.accounts.authority.to_account_info(), true)
        .permissioned_account(&ctx.accounts.probe.to_account_info(), true)
        .permission(&ctx.accounts.permission.to_account_info())
        .system_program(&ctx.accounts.system_program.to_account_info())
        .owner_program(&ctx.accounts.permission_program.to_account_info())
        .delegation_buffer(&ctx.accounts.permission_buffer.to_account_info())
        .delegation_record(&ctx.accounts.permission_record.to_account_info())
        .delegation_metadata(&ctx.accounts.permission_metadata.to_account_info())
        .delegation_program(&ctx.accounts.delegation_program.to_account_info())
        .validator(Some(&ctx.accounts.validator.to_account_info()))
        .invoke_signed(&[seeds])?;

    // The SDK derives and appends the bump itself.
    ctx.accounts.delegate_probe(
        &ctx.accounts.authority,
        &[PROBE_SEED, &id],
        DelegateConfig { validator: Some(TEE_VALIDATOR), ..Default::default() },
    )?;
    Ok(())
}

pub fn write_probe(ctx: Context<WriteProbe>, value: u64) -> Result<()> {
    ctx.accounts.probe.value = value;
    Ok(())
}

pub fn check_price(ctx: Context<CheckPrice>) -> Result<()> {
    let clock = Clock::get()?;
    let price = loan_core::oracle::read_sol_usd_price(&ctx.accounts.price_update, &clock)
        .map_err(core_error)?;
    let probe = &mut ctx.accounts.probe;
    probe.price = price.price;
    probe.price_exponent = price.exponent;
    Ok(())
}

pub fn undelegate_probe(ctx: Context<UndelegateProbe>) -> Result<()> {
    ctx.accounts.probe.exit(&crate::ID)?;
    MagicIntentBundleBuilder::new(
        ctx.accounts.authority.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.probe.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(id: [u8; 32])]
pub struct CreateProbe<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Probe::INIT_SPACE,
        seeds = [PROBE_SEED, id.as_ref()],
        bump,
    )]
    pub probe: Account<'info, Probe>,
    /// CHECK: Created by the permission program, seeds checked there.
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    pub permission_program: Program<'info, PermissionProgram>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(id: [u8; 32])]
pub struct DelegateProbe<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: The probe PDA; ownership moves to the delegation program here.
    #[account(mut, del, seeds = [PROBE_SEED, id.as_ref()], bump)]
    pub probe: UncheckedAccount<'info>,
    /// CHECK: Permission PDA for the probe, checked by the permission program.
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Delegation buffer for the permission, checked by the delegation program.
    #[account(mut)]
    pub permission_buffer: UncheckedAccount<'info>,
    /// CHECK: Delegation record for the permission, checked by the delegation program.
    #[account(mut)]
    pub permission_record: UncheckedAccount<'info>,
    /// CHECK: Delegation metadata for the permission, checked by the delegation program.
    #[account(mut)]
    pub permission_metadata: UncheckedAccount<'info>,
    /// CHECK: Must be the TEE validator.
    #[account(address = TEE_VALIDATOR)]
    pub validator: UncheckedAccount<'info>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[derive(Accounts)]
pub struct WriteProbe<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ PrivateLoanError::Unauthorized)]
    pub probe: Account<'info, Probe>,
}

#[derive(Accounts)]
pub struct CheckPrice<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ PrivateLoanError::Unauthorized)]
    pub probe: Account<'info, Probe>,
    /// CHECK: Owner, feed, age, confidence, and exponent checked by loan_core.
    pub price_update: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateProbe<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ PrivateLoanError::Unauthorized)]
    pub probe: Account<'info, Probe>,
}
