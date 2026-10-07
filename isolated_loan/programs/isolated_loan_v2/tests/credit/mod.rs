//! Story 26.7: credit tiers on LiteSVM. Included from `litesvm_v2.rs` so it shares `Env`.
//!
//! SAS attestation accounts are fixtures in the layout of the SAS program source
//! (`program/src/state/attestation.rs`), owned by the real SAS program id.

use super::*;
use isolated_loan_v2::credit::{CreditConfig, CreditConfigArgs, CREDIT_SEED, OFFER_CREDIT_TIER_OFFSET, SAS_PROGRAM_ID};

const SOL_CREDIT_LTV: u16 = 8_700;

struct Credit {
    issuer: Keypair,
    credential: Pubkey,
    schema: Pubkey,
}

fn credit_pda() -> Pubkey {
    pda(&[CREDIT_SEED])
}

/// Points `Config.authorities.credential_issuer` at a known key and writes an enabled `CreditConfig`.
fn setup(env: &mut Env) -> Credit {
    let issuer = Keypair::new();
    let config_key = pda(&[CONFIG_SEED]);
    let mut config = Config::try_deserialize(&mut &env.svm.get_account(&config_key).unwrap().data[..]).unwrap();
    config.authorities.credential_issuer = issuer.pubkey();
    let mut data = Vec::new();
    config.try_serialize(&mut data).unwrap();
    env.put(config_key, ID, data);
    let c = Credit { issuer, credential: Pubkey::new_unique(), schema: Pubkey::new_unique() };
    let g = env.governance.insecure_clone();
    set_credit(env, &g, &c, true).unwrap();
    // Enough funds for many loans in one test.
    let (l, b) = (env.lender.pubkey(), env.borrower.pubkey());
    env.put_ata(USDC_MINT, l, 100_000_000_000);
    env.put_ata(WSOL_MINT, b, 100_000_000_000);
    c
}

fn set_credit(env: &mut Env, signer: &Keypair, c: &Credit, enabled: bool) -> Result<(), String> {
    let ix = Instruction {
        program_id: ID,
        accounts: isolated_loan_v2::accounts::SetCreditConfig {
            governance: signer.pubkey(),
            config: pda(&[CONFIG_SEED]),
            credit_config: credit_pda(),
            system_program: SYSTEM_PROGRAM,
        }
        .to_account_metas(None),
        data: isolated_loan_v2::instruction::SetCreditConfig {
            args: CreditConfigArgs { sas_program: SAS_PROGRAM_ID, credential: c.credential, schema: c.schema, enabled },
        }
        .data(),
    };
    env.send(ix, signer)
}

#[derive(Clone, Copy)]
struct Fixture {
    subject: Pubkey,
    credential: Pubkey,
    schema: Pubkey,
    signer: Pubkey,
    tier: u8,
    data_expiry: i64,
    sas_expiry: i64,
    owner: Pubkey,
}

fn valid(env: &Env, c: &Credit, tier: u8) -> Fixture {
    Fixture {
        subject: env.borrower.pubkey(),
        credential: c.credential,
        schema: c.schema,
        signer: c.issuer.pubkey(),
        tier,
        data_expiry: env.now + 90 * DAY,
        sas_expiry: env.now + 90 * DAY,
        owner: SAS_PROGRAM_ID,
    }
}

/// Writes an SAS attestation at its SAS PDA `["attestation", credential, schema, nonce]`.
fn put_attestation(env: &mut Env, f: Fixture) -> Pubkey {
    let key = Pubkey::find_program_address(&[b"attestation", f.credential.as_ref(), f.schema.as_ref(), f.subject.as_ref()], &SAS_PROGRAM_ID).0;
    let mut payload = vec![f.tier];
    payload.extend_from_slice(&f.data_expiry.to_le_bytes());
    let mut v = vec![2u8];
    for k in [f.subject, f.credential, f.schema] {
        v.extend_from_slice(k.as_ref());
    }
    v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    v.extend_from_slice(&payload);
    v.extend_from_slice(f.signer.as_ref());
    v.extend_from_slice(&f.sas_expiry.to_le_bytes());
    v.extend_from_slice(Pubkey::default().as_ref());
    env.put(key, f.owner, v);
    key
}

fn extra(attestation: Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(pda(&[CONFIG_SEED]), false),
        AccountMeta::new_readonly(credit_pda(), false),
        AccountMeta::new_readonly(attestation, false),
    ]
}

fn create_extra() -> Vec<AccountMeta> {
    vec![AccountMeta::new_readonly(pda(&[CONFIG_SEED]), false), AccountMeta::new_readonly(credit_pda(), false)]
}

/// Credit terms at `max` / `max + 5` with collateral sized for about `ltv` at $150 (0.1% conf).
fn credit_terms(max: u16, ltv: u16) -> TermsArgs {
    let mut t = args(1).terms();
    t.start_ts = START;
    let exposure = t.core().unwrap().max_exposure().unwrap() as u128;
    // value (micro-USDC) = lamports * 149.85 / 1e9 * 1e6  =>  lamports = value * 1e9 / 149_850_000
    let value = exposure * 10_000 / ltv as u128;
    let lamports = (value * 1_000_000_000 / 149_850_000) as u64 + 1;
    TermsArgs { collateral_amount: lamports, max_ltv_bps: max, liquidation_ltv_bps: max + 500, ..args(1) }
}

fn credit_offer(env: &mut Env, id: u64, max: u16) -> Pubkey {
    let b = env.borrower.pubkey();
    env.create_with(id, credit_terms(max, SOL_CREDIT_LTV.min(max - 20)), b, WSOL_MINT, create_extra()).unwrap()
}

fn accept_credit(env: &mut Env, offer: Pubkey, attestation: Pubkey) -> Result<(), String> {
    let (b, price) = (env.borrower.insecure_clone(), env.price);
    env.accept_with(offer, &b, WSOL_MINT, price, extra(attestation))
}

#[test]
fn tier_3_at_88_percent_is_accepted_and_fixed_on_the_loan() {
    let mut env = Env::new();
    let c = setup(&mut env);
    let f = valid(&env, &c, 3);
    let att = put_attestation(&mut env, f);
    let o = env.create_with(1, credit_terms(8_800, 8_790), env.borrower.pubkey(), WSOL_MINT, create_extra()).unwrap();
    accept_credit(&mut env, o, att).unwrap();
    let s = env.offer(o);
    assert_eq!((s.status, s.max_ltv_bps, s.liquidation_ltv_bps, s.credit_tier()), (StatusV2::Active, 8_800, 9_300, 3));
    // Documented absolute offset of the tier byte.
    assert_eq!(env.svm.get_account(&o).unwrap().data[OFFER_CREDIT_TIER_OFFSET], 3);
    assert_eq!(env.svm.get_account(&o).unwrap().data.len(), OFFER_CREDIT_TIER_OFFSET + 1);
    let ltv = loan_core::math::current_ltv_bps(
        s.terms.core().unwrap().max_exposure().unwrap(),
        loan_core::math::collateral_value_usdc(s.collateral_locked, 150 * USD, (150 * USD / 1000) as u64, -8).unwrap(),
    )
    .unwrap();
    assert!(ltv > 8_500 && ltv <= 8_800, "origination LTV {ltv}");
}

#[test]
fn invalid_credentials_fall_back_to_the_standard_caps() {
    let mut env = Env::new();
    let c = setup(&mut env);
    let good = valid(&env, &c, 3);
    let now = env.now;
    let cases: Vec<(&str, Fixture)> = vec![
        ("expired data", Fixture { data_expiry: now, ..good }),
        ("expired sas", Fixture { sas_expiry: now - 1, ..good }),
        ("wrong issuer", Fixture { signer: Pubkey::new_unique(), ..good }),
        ("wrong schema", Fixture { schema: Pubkey::new_unique(), ..good }),
        ("wrong credential", Fixture { credential: Pubkey::new_unique(), ..good }),
        ("wrong subject", Fixture { subject: env.stranger.pubkey(), ..good }),
        ("wrong owner", Fixture { owner: Pubkey::new_unique(), ..good }),
        ("tier out of range", Fixture { tier: 9, ..good }),
    ];
    let mut id = 10;
    for (name, f) in cases {
        let att = put_attestation(&mut env, f);
        let o = credit_offer(&mut env, id, 8_000);
        let r = accept_credit(&mut env, o, att);
        assert!(r.as_ref().err().is_some_and(|m| m.contains(&code(LoanV2Error::CreditTierRequired))), "{name}: {r:?}");
        // The same credential on standard terms: accepted at the standard caps, no tier.
        let o2 = env.create(id + 1, args(1), env.borrower.pubkey()).unwrap();
        accept_credit(&mut env, o2, att).unwrap();
        assert_eq!(env.offer(o2).credit_tier(), 0, "{name}");
        env.svm.set_account(att, Account::default()).unwrap();
        id += 2;
    }
    // Revoked: SAS closes the account, so it no longer exists.
    let att = put_attestation(&mut env, good);
    env.svm.set_account(att, Account::default()).unwrap();
    let o = credit_offer(&mut env, 100, 8_000);
    assert_err(accept_credit(&mut env, o, att), LoanV2Error::CreditTierRequired);
    // No credit accounts at all.
    let price = env.price;
    let b = env.borrower.insecure_clone();
    assert_err(env.accept_with(o, &b, WSOL_MINT, price, vec![]), LoanV2Error::CreditTierRequired);
    // A lower tier than the terms need.
    let att = put_attestation(&mut env, Fixture { tier: 1, ..good });
    let o = credit_offer(&mut env, 101, 8_500);
    assert_err(accept_credit(&mut env, o, att), LoanV2Error::CreditTierRequired);
    let att = put_attestation(&mut env, Fixture { tier: 2, ..good });
    accept_credit(&mut env, o, att).unwrap();
    assert_eq!(env.offer(o).credit_tier(), 2);
}

#[test]
fn tier_stays_fixed_after_the_credential_expires_mid_loan() {
    let mut env = Env::new();
    let c = setup(&mut env);
    let f = Fixture { data_expiry: env.now + 2 * DAY, sas_expiry: env.now + 2 * DAY, ..valid(&env, &c, 3) };
    let att = put_attestation(&mut env, f);
    let o = credit_offer(&mut env, 1, 8_800);
    accept_credit(&mut env, o, att).unwrap();
    env.at(START + 10 * DAY);
    // Past the credential's expiry, at about 90% LTV: above the standard 85% line, below the
    // tier's 93% (and its 96% emergency). The loan keeps tier 3 and is not liquidatable.
    env.price_usd(145, 145);
    let s = env.stranger.insecure_clone();
    assert_err(env.liquidate(o, &s), LoanV2Error::LoanHealthy);
    assert_eq!(env.offer(o).credit_tier(), 3);
    // Past the tier's emergency line it liquidates like any loan.
    env.price_usd(128, 150);
    env.liquidate(o, &s).unwrap();
    assert_eq!(env.offer(o).status, StatusV2::Liquidated);
}

#[test]
fn credit_terms_are_invite_only_and_gated_by_the_pilot() {
    let mut env = Env::new();
    let c = setup(&mut env);
    let f = valid(&env, &c, 3);
    let att = put_attestation(&mut env, f);
    // An open offer cannot carry credit caps.
    assert_err(env.create_with(1, credit_terms(8_000, 7_900), Pubkey::default(), WSOL_MINT, create_extra()).map(|_| ()), LoanV2Error::CreditNotInvited);
    // An open offer on standard caps ignores a valid credential.
    let o = env.create(2, args(1), Pubkey::default()).unwrap();
    accept_credit(&mut env, o, att).unwrap();
    assert_eq!(env.offer(o).credit_tier(), 0);
    // Credit caps need the pilot's config accounts and the pilot enabled.
    let b = env.borrower.pubkey();
    assert_err(env.create_with(3, credit_terms(8_000, 7_900), b, WSOL_MINT, vec![]).map(|_| ()), LoanV2Error::CreditDisabled);
    let g = env.governance.insecure_clone();
    set_credit(&mut env, &g, &c, false).unwrap();
    assert_err(env.create_with(3, credit_terms(8_000, 7_900), b, WSOL_MINT, create_extra()).map(|_| ()), LoanV2Error::CreditDisabled);
    // Disabling stops pending credit offers too.
    set_credit(&mut env, &g, &c, true).unwrap();
    let o = credit_offer(&mut env, 4, 8_000);
    set_credit(&mut env, &g, &c, false).unwrap();
    assert_err(accept_credit(&mut env, o, att), LoanV2Error::CreditTierRequired);
    // Only governance writes the credit config.
    let s = env.stranger.insecure_clone();
    assert_err(set_credit(&mut env, &s, &c, true), LoanV2Error::WrongAuthority);
    // Above tier 3 is never allowed.
    assert_err(env.create_with(5, credit_terms(8_900, 8_800), b, WSOL_MINT, create_extra()).map(|_| ()), LoanV2Error::InvalidTerms);
}

#[test]
fn credit_request_needs_the_credential_at_create_and_fund() {
    let mut env = Env::new();
    let c = setup(&mut env);
    let short = Fixture { data_expiry: env.now + DAY, sas_expiry: 0, ..valid(&env, &c, 2) };
    let att = put_attestation(&mut env, short);
    let b = env.borrower.insecure_clone();
    let l = env.lender.insecure_clone();
    let request = pda(&[REQUEST_SEED, b.pubkey().as_ref(), &5u64.to_le_bytes()]);
    let vault = pda(&[REQUEST_WSOL_VAULT_SEED, request.as_ref()]);
    let terms = credit_terms(8_500, 8_400);
    let create = |env: &mut Env, extra: Vec<AccountMeta>| {
        let mut accounts = isolated_loan_v2::accounts::CreateRequest {
            borrower: b.pubkey(),
            request,
            usdc_mint: USDC_MINT,
            wsol_mint: WSOL_MINT,
            request_vault: vault,
            borrower_wsol: ata(b.pubkey(), WSOL_MINT),
            borrower_usdc: ata(b.pubkey(), USDC_MINT),
            token_program: TOKEN_PROGRAM,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM_PROGRAM,
        }
        .to_account_metas(None);
        accounts.extend(extra);
        env.send(Instruction { program_id: ID, accounts, data: isolated_loan_v2::instruction::CreateRequest { request_id: 5, args: terms }.data() }, &b)
    };
    assert_err(create(&mut env, vec![]), LoanV2Error::CreditTierRequired);
    create(&mut env, extra(att)).unwrap();
    let offer = offer_pda(l.pubkey(), 6);
    let fund = |env: &mut Env, extra: Vec<AccountMeta>| {
        let mut accounts = isolated_loan_v2::accounts::FundRequest {
            lender: l.pubkey(),
            request,
            borrower: b.pubkey(),
            price_update: env.price,
            offer,
            wsol_mint: WSOL_MINT,
            request_vault: vault,
            wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
            lender_usdc: ata(l.pubkey(), USDC_MINT),
            borrower_usdc: ata(b.pubkey(), USDC_MINT),
            token_program: TOKEN_PROGRAM,
            system_program: SYSTEM_PROGRAM,
        }
        .to_account_metas(None);
        accounts.extend(extra);
        env.send(Instruction { program_id: ID, accounts, data: isolated_loan_v2::instruction::FundRequest { offer_id: 6 }.data() }, &l)
    };
    // The credential expired before funding: the request cannot fund at credit caps.
    env.at(START + 2 * DAY);
    env.price_usd(150, 150);
    assert_err(fund(&mut env, extra(att)), LoanV2Error::CreditTierRequired);
    let renewed = Fixture { data_expiry: env.now + 30 * DAY, ..short };
    put_attestation(&mut env, renewed);
    fund(&mut env, extra(att)).unwrap();
    let s = env.offer(offer);
    assert_eq!((s.status, s.credit_tier(), s.max_ltv_bps), (StatusV2::Active, 2, 8_500));
}

#[test]
fn credit_config_needs_every_id() {
    let mut env = Env::new();
    let c = setup(&mut env);
    let g = env.governance.insecure_clone();
    let bad = Credit { issuer: Keypair::new(), credential: Pubkey::default(), schema: c.schema };
    assert_err(set_credit(&mut env, &g, &bad, true), LoanV2Error::InvalidCreditConfig);
    let stored = CreditConfig::try_deserialize(&mut &env.svm.get_account(&credit_pda()).unwrap().data[..]).unwrap();
    assert_eq!((stored.sas_program, stored.credential, stored.schema, stored.enabled), (SAS_PROGRAM_ID, c.credential, c.schema, true));
}
