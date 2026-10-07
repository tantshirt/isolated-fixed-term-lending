//! Governance `Config` and per-asset `CollateralConfig` (Stories 19.5 and 26.2).
//!
//! `Config` holds the separated keys from the `governance` crate, exactly as in
//! `private_loan_v2`. Only `authorities.governance` (the Squads vault on Devnet) writes a
//! `CollateralConfig`. Canonical wSOL never has one: it keeps the built-in constants, so active
//! wSOL loans need no migration (research.md § Per-asset collateral).

use crate::error::LoanV2Error;
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use governance::Authorities;
use loan_core::constants::{MAX_LIQUIDATION_LTV_BPS, MAX_LTV_BPS, MIN_LTV_GAP_BPS, SOL_USD_FEED_ID, USDC_MINT, WSOL_MINT};

pub const CONFIG_SEED: &[u8] = b"config";
pub const COLLATERAL_SEED: &[u8] = b"collateral";
pub const COLLATERAL_CONFIG_VERSION: u8 = 1;
/// Smallest and largest collateral decimals accepted. Below 3 the valuation divisor
/// `decimals - 6 - exponent` could go negative at the largest allowed exponent (-3).
pub const MIN_COLLATERAL_DECIMALS: u8 = 3;
pub const MAX_COLLATERAL_DECIMALS: u8 = 18;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub authorities: Authorities,
    pub bump: u8,
}

/// One collateral asset other than canonical wSOL. Seeds `["collateral", mint]`.
#[account]
#[derive(InitSpace)]
pub struct CollateralConfig {
    pub version: u8,
    pub mint: Pubkey,
    /// Copied from the mint at the first write; a mint's decimals never change.
    pub decimals: u8,
    /// Pyth feed that prices this asset in USD. Every V1 oracle check still applies.
    pub feed_id: [u8; 32],
    /// Highest max LTV an offer or request in this asset may use.
    pub max_ltv_bps: u16,
    /// Highest liquidation LTV an offer or request in this asset may use.
    pub liquidation_ltv_bps: u16,
    /// Gates new originations only. Servicing, liquidation and recovery of existing loans keep
    /// reading the feed when an asset is disabled.
    pub enabled: bool,
    pub bump: u8,
    pub reserved: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct CollateralConfigArgs {
    pub feed_id: [u8; 32],
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
    pub enabled: bool,
}

/// How one loan's collateral is priced and capped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Collateral {
    pub feed_id: [u8; 32],
    pub decimals: u8,
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
}

impl Collateral {
    /// Canonical wSOL: SOL/USD, 9 decimals, the week-1 caps.
    pub const BUILT_IN_SOL: Collateral = Collateral {
        feed_id: SOL_USD_FEED_ID,
        decimals: 9,
        max_ltv_bps: MAX_LTV_BPS,
        liquidation_ltv_bps: MAX_LIQUIDATION_LTV_BPS,
    };

    /// Terms may not exceed this asset's caps (the global caps are checked separately).
    pub fn check_caps(&self, max_ltv_bps: u16, liquidation_ltv_bps: u16) -> Result<()> {
        require!(max_ltv_bps <= self.max_ltv_bps && liquidation_ltv_bps <= self.liquidation_ltv_bps, LoanV2Error::InvalidTerms);
        Ok(())
    }
}

/// Resolves pricing for a loan's collateral `mint`.
///
/// - Canonical wSOL always uses the built-in constants; any extra account is ignored.
/// - Any other mint needs its `CollateralConfig` as the first remaining account: owned by this
///   program, at `["collateral", mint]`, for this mint, and enabled when `originating`.
/// - A `local-mints` build (never deployed) with no config passed keeps the week-1 behaviour of
///   pricing a self-made mint as SOL, so Surfpool walkthroughs still work.
pub fn resolve(mint: &Pubkey, remaining: &[AccountInfo], originating: bool) -> Result<Collateral> {
    if *mint == WSOL_MINT {
        return Ok(Collateral::BUILT_IN_SOL);
    }
    let Some(info) = remaining.first() else {
        if cfg!(feature = "local-mints") {
            return Ok(Collateral::BUILT_IN_SOL);
        }
        return err!(LoanV2Error::CollateralNotConfigured);
    };
    require_keys_eq!(*info.owner, crate::ID, LoanV2Error::CollateralNotConfigured);
    let c = CollateralConfig::try_deserialize(&mut &info.try_borrow_data()?[..]).map_err(|_| error!(LoanV2Error::CollateralNotConfigured))?;
    require_keys_eq!(c.mint, *mint, LoanV2Error::CollateralNotConfigured);
    let expected = Pubkey::create_program_address(&[COLLATERAL_SEED, mint.as_ref(), &[c.bump]], &crate::ID)
        .map_err(|_| error!(LoanV2Error::CollateralNotConfigured))?;
    require_keys_eq!(expected, info.key(), LoanV2Error::CollateralNotConfigured);
    if originating {
        require!(c.enabled, LoanV2Error::CollateralDisabled);
    }
    Ok(Collateral { feed_id: c.feed_id, decimals: c.decimals, max_ltv_bps: c.max_ltv_bps, liquidation_ltv_bps: c.liquidation_ltv_bps })
}

/// Once, by the program's upgrade authority. After the upgrade authority moves to the Squads
/// vault, only `rotate_authorities` changes the keys.
pub fn init_config(ctx: Context<InitConfig>, authorities: Authorities) -> Result<()> {
    require!(governance::loader::is_upgrade_authority(
        &ctx.accounts.program.to_account_info(), &ctx.accounts.program_data.to_account_info(), &crate::ID, &ctx.accounts.payer.key(),
    ), LoanV2Error::NotUpgradeAuthority);
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

/// Governance creates or updates one asset's config. The mint, its decimals and the PDA are
/// fixed at the first write; feed, caps and the enabled flag may change.
pub fn set_collateral_config(ctx: Context<SetCollateralConfig>, args: CollateralConfigArgs) -> Result<()> {
    let a = &ctx.accounts;
    a.config.authorities.require_policy(&a.governance.key()).map_err(governance_error)?;
    let mint = a.mint.key();
    require!(mint != WSOL_MINT && mint != USDC_MINT, LoanV2Error::InvalidCollateralConfig);
    let decimals = a.mint.decimals;
    require!((MIN_COLLATERAL_DECIMALS..=MAX_COLLATERAL_DECIMALS).contains(&decimals), LoanV2Error::InvalidCollateralConfig);
    require!(args.feed_id != [0u8; 32], LoanV2Error::InvalidCollateralConfig);
    require!(
        args.max_ltv_bps > 0
            && args.max_ltv_bps <= MAX_LTV_BPS
            && args.liquidation_ltv_bps <= MAX_LIQUIDATION_LTV_BPS
            && args.liquidation_ltv_bps >= args.max_ltv_bps.saturating_add(MIN_LTV_GAP_BPS),
        LoanV2Error::InvalidCollateralConfig
    );

    let bump = ctx.bumps.collateral_config;
    let c = &mut ctx.accounts.collateral_config;
    // An existing config keeps its mint and decimals; a fresh one has version 0.
    if c.version != 0 {
        require!(c.mint == mint && c.decimals == decimals, LoanV2Error::InvalidCollateralConfig);
    }
    c.version = COLLATERAL_CONFIG_VERSION;
    c.mint = mint;
    c.decimals = decimals;
    c.feed_id = args.feed_id;
    c.max_ltv_bps = args.max_ltv_bps;
    c.liquidation_ltv_bps = args.liquidation_ltv_bps;
    c.enabled = args.enabled;
    c.bump = bump;
    c.reserved = [0; 32];
    emit!(CollateralConfigSet {
        mint,
        feed_id: args.feed_id,
        max_ltv_bps: args.max_ltv_bps,
        liquidation_ltv_bps: args.liquidation_ltv_bps,
        enabled: args.enabled,
    });
    Ok(())
}

pub fn governance_error(e: governance::GovernanceError) -> Error {
    match e {
        governance::GovernanceError::WrongAuthority => error!(LoanV2Error::WrongAuthority),
        _ => error!(LoanV2Error::InvalidAuthorities),
    }
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub program: Program<'info, crate::program::IsolatedLoanV2>,
    /// CHECK: Loader ownership, linked ProgramData address, variant and upgrade authority
    /// are checked together in the handler before any configuration is accepted.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RotateAuthorities<'info> {
    pub governance: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SetCollateralConfig<'info> {
    /// Must be `config.authorities.governance`; pays rent on the first write.
    #[account(mut)]
    pub governance: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    /// Created on the first write; mint and decimals are checked before every later write.
    #[account(
        init_if_needed,
        payer = governance,
        space = 8 + CollateralConfig::INIT_SPACE,
        seeds = [COLLATERAL_SEED, mint.key().as_ref()],
        bump,
    )]
    pub collateral_config: Account<'info, CollateralConfig>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct CollateralConfigSet {
    pub mint: Pubkey,
    pub feed_id: [u8; 32],
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
    pub enabled: bool,
}
