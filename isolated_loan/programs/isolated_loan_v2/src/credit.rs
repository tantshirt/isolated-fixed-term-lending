//! Credit tiers for the invited wSOL pilot (Story 26.7, research.md § Credit tiers).
//!
//! A borrower holding a valid Solana Attestation Service (SAS) credential from the issuer in
//! `Config.authorities.credential_issuer` may originate at a tier's max LTV (80 / 85 / 88%), with
//! liquidation at max + 5 points and the usual emergency margin (+3) on top. The tier is fixed on
//! the loan at origination, in `OfferV2.reserved[CREDIT_TIER_INDEX]`.
//!
//! Remaining accounts (wSOL only, so there is never a `CollateralConfig` in front of them):
//!
//! | instruction                    | remaining accounts                          |
//! | ------------------------------ | ------------------------------------------- |
//! | create_offer (credit caps)     | `[config, credit_config]`                   |
//! | create_request (credit caps)   | `[config, credit_config, sas_attestation]`  |
//! | accept_offer / fund_request    | `[config, credit_config, sas_attestation]`  |
//!
//! For a non-wSOL mint the credit accounts would start after the `CollateralConfig` (index 1), but
//! the pilot is wSOL only, so they are ignored there.
//!
//! Any credential problem (missing, wrong owner, wrong issuer, wrong schema or credential, wrong
//! subject, expired, revoked, malformed, pilot disabled) yields tier 0: the loan falls back to the
//! standard caps, and credit-tier terms are refused with `CreditTierRequired`.

use crate::config::{governance_error, Config, CONFIG_SEED};
use crate::error::LoanV2Error;
use crate::state::TermsArgs;
use anchor_lang::prelude::*;
use loan_core::constants::{MAX_LIQUIDATION_LTV_BPS, MAX_LTV_BPS, MIN_LTV_GAP_BPS, WSOL_MINT};

pub const CREDIT_SEED: &[u8] = b"credit";
pub const CREDIT_CONFIG_VERSION: u8 = 1;

/// Solana Attestation Service program (solana-foundation/solana-attestation-service, `lib.rs`).
pub const SAS_PROGRAM_ID: Pubkey = pubkey!("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
/// `AttestationAccountDiscriminators::AttestationDiscriminator`.
pub const SAS_ATTESTATION_DISCRIMINATOR: u8 = 2;
/// ZenLo credit schema data: `tier: u8` then `expiry: i64` (little-endian). Nothing else.
pub const CREDIT_SCHEMA_DATA_LEN: usize = 9;

/// Index of the credit tier inside `OfferV2.reserved` (0 = no tier). The last reserved byte, so
/// other features can grow from the front. Absolute account offset: 8 (discriminator) + 345 bytes
/// of fields before `reserved` + 63 = byte 416 of the 417-byte account.
pub const CREDIT_TIER_INDEX: usize = 63;
pub const OFFER_CREDIT_TIER_OFFSET: usize = 416;

/// `(max_ltv_bps, liquidation_ltv_bps)` per tier 1..=3. Emergency is liquidation + 300 bps.
pub const TIER_CAPS: [(u16, u16); 3] = [(8_000, 8_500), (8_500, 9_000), (8_800, 9_300)];

/// Governance-written pilot settings. Seeds `["credit"]`. The issuer key is not copied here: it is
/// `Config.authorities.credential_issuer`, so a rotation takes effect at once.
#[account]
#[derive(InitSpace)]
pub struct CreditConfig {
    pub version: u8,
    /// Gates credit-tier originations only; loans already open keep their tier.
    pub enabled: bool,
    /// SAS program that must own the attestation account.
    pub sas_program: Pubkey,
    /// SAS credential account (the issuer's credential).
    pub credential: Pubkey,
    /// SAS schema account for the ZenLo credit tier (`tier: u8, expiry: i64`).
    pub schema: Pubkey,
    pub bump: u8,
    pub reserved: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct CreditConfigArgs {
    pub sas_program: Pubkey,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub enabled: bool,
}

/// Tier caps, or `None` outside 1..=3.
pub fn tier_caps(tier: u8) -> Option<(u16, u16)> {
    match tier {
        1..=3 => Some(TIER_CAPS[(tier - 1) as usize]),
        _ => None,
    }
}

/// The smallest tier whose caps cover these terms: 0 when the standard caps do, `None` when no
/// tier does. Does not check the 5-point gap (validation does).
pub fn required_tier(max_ltv_bps: u16, liquidation_ltv_bps: u16) -> Option<u8> {
    if max_ltv_bps <= MAX_LTV_BPS && liquidation_ltv_bps <= MAX_LIQUIDATION_LTV_BPS {
        return Some(0);
    }
    (1u8..=3).find(|t| {
        let (max, liq) = TIER_CAPS[(*t - 1) as usize];
        max_ltv_bps <= max && liquidation_ltv_bps <= liq
    })
}

/// Validates new terms, allowing credit-tier caps. Returns the tier the caps need (0 = standard).
pub fn validate_terms(args: &TermsArgs, now: i64) -> Result<u8> {
    let required = required_tier(args.max_ltv_bps, args.liquidation_ltv_bps).ok_or(LoanV2Error::InvalidTerms)?;
    if required == 0 {
        args.validate(now)?;
        return Ok(0);
    }
    // Same checks as `TermsArgs::validate`, with the credit caps in place of 70% / 85%: the
    // week-1 rate and duration caps (checked with a neutral LTV pair), the 5-point gap, then
    // every V2 accounting rule.
    require!(args.collateral_amount > 0 && args.max_ltv_bps > 0, LoanV2Error::InvalidTerms);
    loan_core::math::validate_terms(args.interest_bps, args.duration, 0, MIN_LTV_GAP_BPS).map_err(crate::error::core_error)?;
    require!(args.liquidation_ltv_bps >= args.max_ltv_bps.saturating_add(MIN_LTV_GAP_BPS), LoanV2Error::InvalidTerms);
    let mut t = args.terms();
    t.start_ts = now;
    t.core()?.validate().map_err(crate::error::core_error)?;
    Ok(required)
}

/// Where the credit accounts start for this collateral mint.
pub fn credit_accounts<'a, 'info>(mint: &Pubkey, remaining: &'a [AccountInfo<'info>]) -> &'a [AccountInfo<'info>] {
    let start = if *mint == WSOL_MINT { 0 } else { 1 };
    remaining.get(start..).unwrap_or(&[])
}

/// The pilot is on: `[config, credit_config]` are the real accounts and the config is enabled.
/// Used when a lender posts credit-tier terms.
pub fn pilot_enabled(accounts: &[AccountInfo]) -> bool {
    load_configs(accounts).map(|(_, c)| c.enabled).unwrap_or(false)
}

fn load_configs(accounts: &[AccountInfo]) -> Option<(Config, CreditConfig)> {
    let (config_info, credit_info) = (accounts.first()?, accounts.get(1)?);
    if *config_info.owner != crate::ID || *credit_info.owner != crate::ID {
        return None;
    }
    let config = Config::try_deserialize(&mut &config_info.try_borrow_data().ok()?[..]).ok()?;
    let expected = Pubkey::create_program_address(&[CONFIG_SEED, &[config.bump]], &crate::ID).ok()?;
    if expected != config_info.key() {
        return None;
    }
    let credit = CreditConfig::try_deserialize(&mut &credit_info.try_borrow_data().ok()?[..]).ok()?;
    let expected = Pubkey::create_program_address(&[CREDIT_SEED, &[credit.bump]], &crate::ID).ok()?;
    if expected != credit_info.key() {
        return None;
    }
    Some((config, credit))
}

/// The fields of an SAS `Attestation` account that ZenLo reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SasAttestation {
    pub nonce: Pubkey,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub data: Vec<u8>,
    pub signer: Pubkey,
    pub expiry: i64,
}

/// Parses an SAS attestation account. Layout from the SAS program source
/// (`program/src/state/attestation.rs`, `to_bytes_inner`):
///
/// ```text
/// [0]      discriminator u8 = 2
/// [1..33]  nonce Pubkey          (the subject wallet for ZenLo credentials)
/// [33..65] credential Pubkey
/// [65..97] schema Pubkey
/// [97..101] data length u32 LE, then `len` data bytes
/// then     signer Pubkey, expiry i64 LE (0 = never), token_account Pubkey
/// ```
pub fn parse_sas_attestation(raw: &[u8]) -> Option<SasAttestation> {
    let key = |at: usize| raw.get(at..at + 32).map(|b| Pubkey::new_from_array(b.try_into().unwrap()));
    if *raw.first()? != SAS_ATTESTATION_DISCRIMINATOR {
        return None;
    }
    let (nonce, credential, schema) = (key(1)?, key(33)?, key(65)?);
    let len = u32::from_le_bytes(raw.get(97..101)?.try_into().ok()?) as usize;
    let data_end = 101usize.checked_add(len)?;
    let data = raw.get(101..data_end)?.to_vec();
    let signer = key(data_end)?;
    let expiry = i64::from_le_bytes(raw.get(data_end + 32..data_end + 40)?.try_into().ok()?);
    // token_account follows; it must be present for the account to be well formed.
    key(data_end + 40)?;
    Some(SasAttestation { nonce, credential, schema, data, signer, expiry })
}

/// Checks a parsed attestation against the pilot settings and returns its tier, or 0.
pub fn tier_of(a: &SasAttestation, issuer: &Pubkey, credit: &CreditConfig, subject: &Pubkey, now: i64) -> u8 {
    if a.signer != *issuer || a.credential != credit.credential || a.schema != credit.schema || a.nonce != *subject {
        return 0;
    }
    if a.expiry != 0 && a.expiry <= now {
        return 0;
    }
    if a.data.len() != CREDIT_SCHEMA_DATA_LEN {
        return 0;
    }
    let tier = a.data[0];
    let data_expiry = i64::from_le_bytes(a.data[1..9].try_into().unwrap());
    if data_expiry <= now || tier_caps(tier).is_none() {
        return 0;
    }
    tier
}

/// Tier proven by `[config, credit_config, sas_attestation]` for `subject` now, or 0 for any
/// failure: pilot disabled, wrong or fake config accounts, attestation not owned by the SAS
/// program (a revoked attestation is closed, so it fails here), malformed data, wrong issuer,
/// credential, schema or subject, or expired.
pub fn credential_tier(accounts: &[AccountInfo], subject: &Pubkey, now: i64) -> u8 {
    let Some((config, credit)) = load_configs(accounts) else { return 0 };
    let Some(att) = accounts.get(2) else { return 0 };
    if !credit.enabled || *att.owner != credit.sas_program || att.lamports() == 0 {
        return 0;
    }
    let Ok(raw) = att.try_borrow_data() else { return 0 };
    let Some(parsed) = parse_sas_attestation(&raw) else { return 0 };
    tier_of(&parsed, &config.authorities.credential_issuer, &credit, subject, now)
}

/// Accept or fund: the tier to record on the loan, checking credit-tier caps against the
/// credential. `invited` is false for an open (unrestricted) offer, which ignores any credential.
pub fn origination_tier(max_ltv_bps: u16, liquidation_ltv_bps: u16, mint: &Pubkey, remaining: &[AccountInfo], subject: &Pubkey, invited: bool, now: i64) -> Result<u8> {
    let required = required_tier(max_ltv_bps, liquidation_ltv_bps).ok_or(LoanV2Error::InvalidTerms)?;
    if required == 0 {
        return Ok(0);
    }
    require!(invited && *mint == WSOL_MINT, LoanV2Error::CreditNotInvited);
    let tier = credential_tier(credit_accounts(mint, remaining), subject, now);
    require!(tier >= required, LoanV2Error::CreditTierRequired);
    Ok(tier)
}

/// Governance creates or updates the pilot settings.
pub fn set_credit_config(ctx: Context<SetCreditConfig>, args: CreditConfigArgs) -> Result<()> {
    let a = &ctx.accounts;
    a.config.authorities.require_policy(&a.governance.key()).map_err(governance_error)?;
    require!(
        args.sas_program != Pubkey::default() && args.credential != Pubkey::default() && args.schema != Pubkey::default(),
        LoanV2Error::InvalidCreditConfig
    );
    let bump = ctx.bumps.credit_config;
    let c = &mut ctx.accounts.credit_config;
    c.version = CREDIT_CONFIG_VERSION;
    c.enabled = args.enabled;
    c.sas_program = args.sas_program;
    c.credential = args.credential;
    c.schema = args.schema;
    c.bump = bump;
    c.reserved = [0; 32];
    emit!(CreditConfigSet { sas_program: args.sas_program, credential: args.credential, schema: args.schema, enabled: args.enabled });
    Ok(())
}

#[derive(Accounts)]
pub struct SetCreditConfig<'info> {
    /// Must be `config.authorities.governance`; pays rent on the first write.
    #[account(mut)]
    pub governance: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init_if_needed, payer = governance, space = 8 + CreditConfig::INIT_SPACE, seeds = [CREDIT_SEED], bump)]
    pub credit_config: Account<'info, CreditConfig>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct CreditConfigSet {
    pub sas_program: Pubkey,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub enabled: bool,
}

/// A loan originated at a credit tier. Carries no income data: only the tier and caps.
#[event]
pub struct CreditOriginatedV2 {
    pub offer: Pubkey,
    pub borrower: Pubkey,
    pub tier: u8,
    pub max_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attestation_bytes(nonce: Pubkey, credential: Pubkey, schema: Pubkey, data: &[u8], signer: Pubkey, expiry: i64) -> Vec<u8> {
        let mut v = vec![SAS_ATTESTATION_DISCRIMINATOR];
        for k in [nonce, credential, schema] {
            v.extend_from_slice(k.as_ref());
        }
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        v.extend_from_slice(data);
        v.extend_from_slice(signer.as_ref());
        v.extend_from_slice(&expiry.to_le_bytes());
        v.extend_from_slice(Pubkey::default().as_ref());
        v
    }

    fn data(tier: u8, expiry: i64) -> Vec<u8> {
        let mut d = vec![tier];
        d.extend_from_slice(&expiry.to_le_bytes());
        d
    }

    fn credit() -> CreditConfig {
        CreditConfig { version: 1, enabled: true, sas_program: SAS_PROGRAM_ID, credential: Pubkey::new_unique(), schema: Pubkey::new_unique(), bump: 0, reserved: [0; 32] }
    }

    #[test]
    fn tiers_follow_research() {
        assert_eq!(tier_caps(1), Some((8_000, 8_500)));
        assert_eq!(tier_caps(2), Some((8_500, 9_000)));
        assert_eq!(tier_caps(3), Some((8_800, 9_300)));
        assert_eq!(tier_caps(0), None);
        assert_eq!(tier_caps(4), None);
        for (max, liq) in TIER_CAPS {
            assert_eq!(liq, max + MIN_LTV_GAP_BPS);
        }
        assert_eq!(required_tier(7_000, 8_500), Some(0));
        assert_eq!(required_tier(7_500, 8_500), Some(1));
        assert_eq!(required_tier(8_000, 8_600), Some(2));
        assert_eq!(required_tier(8_800, 9_300), Some(3));
        assert_eq!(required_tier(8_900, 9_400), None);
        assert_eq!(required_tier(7_000, 9_400), None);
    }

    #[test]
    fn parses_the_sas_layout_and_checks_every_field() {
        let (subject, issuer, now) = (Pubkey::new_unique(), Pubkey::new_unique(), 1_000);
        let c = credit();
        let raw = attestation_bytes(subject, c.credential, c.schema, &data(3, now + 10), issuer, 0);
        let a = parse_sas_attestation(&raw).unwrap();
        assert_eq!(tier_of(&a, &issuer, &c, &subject, now), 3);
        // Wrong issuer, subject, credential, schema.
        assert_eq!(tier_of(&a, &Pubkey::new_unique(), &c, &subject, now), 0);
        assert_eq!(tier_of(&a, &issuer, &c, &Pubkey::new_unique(), now), 0);
        let other = CreditConfig { credential: Pubkey::new_unique(), ..c.clone() };
        assert_eq!(tier_of(&a, &issuer, &other, &subject, now), 0);
        let other = CreditConfig { schema: Pubkey::new_unique(), ..c.clone() };
        assert_eq!(tier_of(&a, &issuer, &other, &subject, now), 0);
        // Data expiry and SAS expiry.
        assert_eq!(tier_of(&a, &issuer, &c, &subject, now + 10), 0);
        let raw = attestation_bytes(subject, c.credential, c.schema, &data(2, now + 10), issuer, now);
        assert_eq!(tier_of(&parse_sas_attestation(&raw).unwrap(), &issuer, &c, &subject, now), 0);
        // Bad tier, bad length, wrong discriminator, truncated.
        let raw = attestation_bytes(subject, c.credential, c.schema, &data(4, now + 10), issuer, 0);
        assert_eq!(tier_of(&parse_sas_attestation(&raw).unwrap(), &issuer, &c, &subject, now), 0);
        let mut long = data(1, now + 10);
        long.push(0);
        let raw = attestation_bytes(subject, c.credential, c.schema, &long, issuer, 0);
        assert_eq!(tier_of(&parse_sas_attestation(&raw).unwrap(), &issuer, &c, &subject, now), 0);
        let mut raw = attestation_bytes(subject, c.credential, c.schema, &data(1, now + 10), issuer, 0);
        raw[0] = 1;
        assert!(parse_sas_attestation(&raw).is_none());
        raw[0] = 2;
        raw.truncate(raw.len() - 1);
        assert!(parse_sas_attestation(&raw).is_none());
    }
}
