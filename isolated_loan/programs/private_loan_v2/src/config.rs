//! Governed authorities (Story 19.5). One `Config` account holds the separated keys from the
//! `governance` crate. The Squads vault (`governance`) is the only key that rotates them; the AI
//! admin, AI worker, liquidation-pool admin, credential issuer and keeper are operational.

use crate::ai::AiConfig;
use crate::constants::{AI_CONFIG_SEED, CONFIG_SEED};
use crate::error::{governance_error, PrivateLoanError};
use anchor_lang::prelude::*;
use governance::Authorities;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub authorities: Authorities,
    pub bump: u8,
}

/// Once, by the program's upgrade authority, in the deploy transaction sequence. After the
/// upgrade authority moves to the Squads vault, only `rotate_authorities` changes anything.
pub fn init_config(ctx: Context<InitConfig>, authorities: Authorities) -> Result<()> {
    authorities.validate().map_err(governance_error)?;
    let c = &mut ctx.accounts.config;
    c.version = 1;
    c.authorities = authorities;
    c.bump = ctx.bumps.config;
    Ok(())
}

pub fn rotate_authorities(ctx: Context<RotateAuthorities>, next: Authorities) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.authorities = c.authorities.rotate(&ctx.accounts.governance.key(), next).map_err(governance_error)?;
    // AI requests and callbacks use this operational configuration. Revoke the old worker in
    // the same transaction as governance rotation, preserving the administrator's enabled flag.
    // The account may not exist yet if the copilot has never been configured.
    let info = ctx.accounts.ai_config.to_account_info();
    if !info.data_is_empty() {
        require_keys_eq!(*info.owner, crate::ID, PrivateLoanError::InvalidRecord);
        let mut ai = AiConfig::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        ai.worker = next.ai_worker;
        ai.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key()) @ PrivateLoanError::NotUpgradeAuthority,
    )]
    pub program: Program<'info, crate::program::PrivateLoanV2>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ PrivateLoanError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RotateAuthorities<'info> {
    pub governance: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: Canonical AI configuration; if initialized, owner and discriminator are checked
    /// before updating its worker. Required even when absent so rotation cannot skip revocation.
    #[account(mut, seeds = [AI_CONFIG_SEED], bump)]
    pub ai_config: UncheckedAccount<'info>,
}
