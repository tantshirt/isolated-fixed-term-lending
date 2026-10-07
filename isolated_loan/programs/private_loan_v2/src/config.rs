//! Governed authorities (Story 19.5). One `Config` account holds the separated keys from the
//! `governance` crate. The Squads vault (`governance`) is the only key that rotates them; the AI
//! admin, AI worker, liquidation-pool admin, credential issuer and keeper are operational.

use crate::constants::CONFIG_SEED;
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
}
