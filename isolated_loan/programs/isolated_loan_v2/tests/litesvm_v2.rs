//! V2 instruction tests on LiteSVM (Stories 21.1, 21.2, 26.1, 26.2). Run `anchor build` first.
//! Every boundary is driven by setting the clock to the exact second. The Pyth account is owned by
//! the real receiver program, so the owner check is exercised, never bypassed.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use isolated_loan_v2::error::LoanV2Error;
use isolated_loan_v2::state::{OfferV2, RequestStatusV2, RequestV2, StatusV2, TermsArgs};
use isolated_loan_v2::{OFFER_SEED, REQUEST_SEED, REQUEST_WSOL_VAULT_SEED, USDC_VAULT_SEED, WSOL_VAULT_SEED};
use litesvm::LiteSVM;
use loan_core::accounting as acc;
use governance::Authorities;
use isolated_loan_v2::config::{CollateralConfig, CollateralConfigArgs, Config, COLLATERAL_SEED, CONFIG_SEED};
use loan_core::constants::{JITOSOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID, SOL_USD_FEED_ID, USDC_MINT, WSOL_MINT};
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
use solana_account::Account;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const TOKEN_PROGRAM: Pubkey = anchor_spl::token::ID;
const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;
const SYSTEM_PROGRAM: Pubkey = anchor_lang::system_program::ID;
const ID: Pubkey = isolated_loan_v2::ID;

const DAY: i64 = 86_400;
const START: i64 = 1_700_000_000;
const PRINCIPAL: u64 = 100_000_000;
const DURATION: i64 = 30 * DAY;
const COLLATERAL: u64 = 1_020_000_000;
const MAX_LTV: u16 = 7_000;
const LIQ_LTV: u16 = 8_000;
const USD: i64 = 100_000_000; // 1 dollar at exponent -8

fn args(policy: u8) -> TermsArgs {
    TermsArgs {
        principal: PRINCIPAL,
        interest_bps: 500,
        duration: DURATION,
        early_repayment: policy,
        min_interest_bps: 2_500,
        grace_seconds: DAY,
        late_fee_bps: 100,
        annual_ceiling_bps: 10_000,
        collateral_amount: COLLATERAL,
        max_ltv_bps: MAX_LTV,
        liquidation_ltv_bps: LIQ_LTV,
    }
}

/// jitoSOL (test) caps from research.md § Per-asset collateral: 60% / 70%.
const JITO_MAX_LTV: u16 = 6_000;
const JITO_LIQ_LTV: u16 = 7_000;
const JITO_COLLATERAL: u64 = 1_100_000_000;

fn jito_args(enabled: bool) -> CollateralConfigArgs {
    CollateralConfigArgs { feed_id: JITOSOL_USD_FEED_ID, max_ltv_bps: JITO_MAX_LTV, liquidation_ltv_bps: JITO_LIQ_LTV, enabled }
}

fn jito_terms() -> TermsArgs {
    TermsArgs { collateral_amount: JITO_COLLATERAL, max_ltv_bps: JITO_MAX_LTV, liquidation_ltv_bps: JITO_LIQ_LTV, ..args(1) }
}

fn code(e: LoanV2Error) -> String {
    format!("Custom({})", u32::from(e))
}

fn assert_err(r: Result<(), String>, e: LoanV2Error) {
    let msg = r.expect_err("expected the instruction to fail");
    assert!(msg.contains(&code(e)), "expected {e:?} ({}), got {msg}", code(e));
}

/// Rejected for one of several reasons (the first account check that trips wins).
fn assert_rejected(r: Result<(), String>, allowed: &[&str]) {
    let msg = r.expect_err("expected the instruction to fail");
    assert!(allowed.iter().any(|a| msg.contains(a)), "expected one of {allowed:?}, got {msg}");
}
const CLOSED_VAULT: &str = "Custom(3012)"; // AccountNotInitialized: the vault closed at settlement
const DUPLICATE: &str = "Custom(2040)"; // ConstraintDuplicateMutableAccount

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &ID).0
}
fn offer_pda(lender: Pubkey, id: u64) -> Pubkey {
    pda(&[OFFER_SEED, lender.as_ref(), &id.to_le_bytes()])
}
fn ata(owner: Pubkey, mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

struct Env {
    svm: LiteSVM,
    lender: Keypair,
    borrower: Keypair,
    stranger: Keypair,
    price: Pubkey,
    /// Squads vault stand-in: `Config.authorities.governance`.
    governance: Keypair,
    /// "jitoSOL (test)": a 9-decimal mint with its own JITOSOL/USD price account.
    jito: Pubkey,
    jito_price: Pubkey,
    now: i64,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/isolated_loan_v2.so");
        svm.add_program_from_file(ID, so).expect("run `anchor build` before the LiteSVM tests");
        let (lender, borrower, stranger, governance) = (Keypair::new(), Keypair::new(), Keypair::new(), Keypair::new());
        for k in [&lender, &borrower, &stranger, &governance] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        let (jito, jito_price) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut env = Env { svm, lender, borrower, stranger, price: Pubkey::new_unique(), governance, jito, jito_price, now: START };
        env.at(START);
        env.put_mint(USDC_MINT, 6);
        env.put_mint(WSOL_MINT, 9);
        env.put_mint(jito, 9);
        for k in [env.lender.pubkey(), env.borrower.pubkey(), env.stranger.pubkey()] {
            env.put_ata(USDC_MINT, k, 1_000_000_000);
            env.put_ata(WSOL_MINT, k, 10_000_000_000);
            env.put_ata(jito, k, 10_000_000_000);
        }
        env.price_usd(150, 150);
        env.put_config();
        env
    }

    /// The governance `Config` as `init_config` would leave it (the upgrade-authority path needs
    /// a ProgramData account LiteSVM does not model, as in private_loan_v2's governance tests).
    fn put_config(&mut self) {
        let (config, bump) = Pubkey::find_program_address(&[CONFIG_SEED], &ID);
        let authorities = Authorities {
            governance: self.governance.pubkey(),
            ai_admin: Pubkey::new_unique(),
            ai_worker: Pubkey::new_unique(),
            liquidation_pool_admin: Pubkey::new_unique(),
            credential_issuer: Pubkey::new_unique(),
            keeper: Pubkey::new_unique(),
        };
        let mut data = Vec::new();
        Config { version: 1, authorities, bump }.try_serialize(&mut data).unwrap();
        self.put(config, ID, data);
    }

    fn collateral_pda(mint: Pubkey) -> Pubkey {
        pda(&[COLLATERAL_SEED, mint.as_ref()])
    }

    fn set_collateral(&mut self, signer: &Keypair, mint: Pubkey, args: CollateralConfigArgs) -> Result<(), String> {
        let ix = Instruction {
            program_id: ID,
            accounts: isolated_loan_v2::accounts::SetCollateralConfig {
                governance: signer.pubkey(),
                config: pda(&[CONFIG_SEED]),
                mint,
                collateral_config: Self::collateral_pda(mint),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan_v2::instruction::SetCollateralConfig { args }.data(),
        };
        self.send(ix, signer)
    }

    /// jitoSOL (test) at 60% / 70%, priced by JITOSOL/USD.
    fn configure_jito(&mut self, enabled: bool) {
        let g = self.governance.insecure_clone();
        let jito = self.jito;
        self.set_collateral(&g, jito, jito_args(enabled)).unwrap();
    }

    /// The remaining account a non-wSOL loan passes: its `CollateralConfig`.
    fn jito_extra(&self) -> Vec<AccountMeta> {
        vec![AccountMeta::new_readonly(Self::collateral_pda(self.jito), false)]
    }

    fn jito_usd(&mut self, spot: i64, ema: i64) {
        let key = self.jito_price;
        self.post_to(key, JITOSOL_USD_FEED_ID, spot * USD, (spot * USD / 1000) as u64, ema * USD, (ema * USD / 1000) as u64, self.now);
    }

    fn at(&mut self, ts: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = ts;
        self.svm.set_sysvar(&clock);
        self.now = ts;
    }

    fn put_mint(&mut self, mint: Pubkey, decimals: u8) {
        let mut data = vec![0u8; 82];
        data[44] = decimals;
        data[45] = 1;
        self.put(mint, TOKEN_PROGRAM, data);
    }

    fn put_ata(&mut self, mint: Pubkey, owner: Pubkey, amount: u64) {
        let key = ata(owner, mint);
        let mut data = vec![0u8; 165];
        data[0..32].copy_from_slice(mint.as_ref());
        data[32..64].copy_from_slice(owner.as_ref());
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        data[108] = 1;
        let rent = self.svm.minimum_balance_for_rent_exemption(data.len());
        let mut lamports = rent;
        if mint == WSOL_MINT {
            data[109] = 1;
            data[113..121].copy_from_slice(&rent.to_le_bytes());
            lamports += amount;
        }
        self.svm.set_account(key, Account { lamports, data, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();
    }

    fn put(&mut self, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(key, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
    }

    /// Spot and EMA in whole dollars, each with a 0.1% confidence, published now.
    fn price_usd(&mut self, spot: i64, ema: i64) {
        self.post(spot * USD, (spot * USD / 1000) as u64, ema * USD, (ema * USD / 1000) as u64, self.now);
    }

    fn post(&mut self, price: i64, conf: u64, ema_price: i64, ema_conf: u64, publish_time: i64) {
        let key = self.price;
        self.post_to(key, SOL_USD_FEED_ID, price, conf, ema_price, ema_conf, publish_time);
    }

    #[allow(clippy::too_many_arguments)]
    fn post_to(&mut self, key: Pubkey, feed_id: [u8; 32], price: i64, conf: u64, ema_price: i64, ema_conf: u64, publish_time: i64) {
        let update = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: VerificationLevel::Full,
            price_message: PriceFeedMessage {
                feed_id,
                price,
                conf,
                exponent: -8,
                publish_time,
                prev_publish_time: publish_time - 1,
                ema_price,
                ema_conf,
            },
            posted_slot: 1,
        };
        let mut data = Vec::with_capacity(PriceUpdateV2::LEN);
        update.try_serialize(&mut data).unwrap();
        self.put(key, PYTH_RECEIVER_PROGRAM_ID, data);
    }

    fn balance(&self, token_account: Pubkey) -> u64 {
        self.svm.get_account(&token_account).map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap())).unwrap_or(0)
    }
    fn usdc(&self, owner: &Keypair) -> u64 {
        self.balance(ata(owner.pubkey(), USDC_MINT))
    }
    fn wsol(&self, owner: &Keypair) -> u64 {
        self.balance(ata(owner.pubkey(), WSOL_MINT))
    }
    fn exists(&self, key: Pubkey) -> bool {
        self.svm.get_account(&key).map(|a| a.lamports > 0).unwrap_or(false)
    }
    fn offer(&self, key: Pubkey) -> OfferV2 {
        OfferV2::try_deserialize(&mut &self.svm.get_account(&key).expect("offer exists").data[..]).unwrap()
    }
    fn request(&self, key: Pubkey) -> RequestV2 {
        RequestV2::try_deserialize(&mut &self.svm.get_account(&key).expect("request exists").data[..]).unwrap()
    }
    fn payoff(&self, offer: Pubkey) -> u64 {
        let o = self.offer(offer);
        acc::payoff(&o.terms.core().unwrap(), &o.ledger.into(), self.now).unwrap()
    }

    fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), String> {
        self.svm.expire_blockhash();
        let tx = Transaction::new(&[signer], Message::new(&[ix], Some(&signer.pubkey())), self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs))
    }

    fn create(&mut self, id: u64, a: TermsArgs, restricted: Pubkey) -> Result<Pubkey, String> {
        self.create_with(id, a, restricted, WSOL_MINT, vec![])
    }

    fn create_with(&mut self, id: u64, a: TermsArgs, restricted: Pubkey, mint: Pubkey, extra: Vec<AccountMeta>) -> Result<Pubkey, String> {
        let lender = self.lender.insecure_clone();
        self.create_by(&lender, id, a, restricted, mint, extra)
    }

    fn create_by(&mut self, lender: &Keypair, id: u64, a: TermsArgs, restricted: Pubkey, mint: Pubkey, extra: Vec<AccountMeta>) -> Result<Pubkey, String> {
        let offer = offer_pda(lender.pubkey(), id);
        let mut accounts = isolated_loan_v2::accounts::CreateOffer {
                lender: lender.pubkey(),
                offer,
                usdc_mint: USDC_MINT,
                wsol_mint: mint,
                usdc_vault: pda(&[USDC_VAULT_SEED, offer.as_ref()]),
                lender_usdc: ata(lender.pubkey(), USDC_MINT),
                token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None);
        accounts.extend(extra);
        let ix = Instruction {
            program_id: ID,
            accounts,
            data: isolated_loan_v2::instruction::CreateOffer { offer_id: id, args: a, restricted_borrower: restricted }.data(),
        };
        self.send(ix, lender).map(|_| offer)
    }

    fn accept_as(&mut self, offer: Pubkey, b: &Keypair) -> Result<(), String> {
        let price = self.price;
        self.accept_with(offer, b, WSOL_MINT, price, vec![])
    }

    fn accept_with(&mut self, offer: Pubkey, b: &Keypair, mint: Pubkey, price: Pubkey, extra: Vec<AccountMeta>) -> Result<(), String> {
        let mut accounts = isolated_loan_v2::accounts::AcceptOffer {
            borrower: b.pubkey(),
            offer,
            lender: self.lender.pubkey(),
            price_update: price,
            usdc_vault: pda(&[USDC_VAULT_SEED, offer.as_ref()]),
            wsol_mint: mint,
            wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
            borrower_usdc: ata(b.pubkey(), USDC_MINT),
            borrower_wsol: ata(b.pubkey(), mint),
            token_program: TOKEN_PROGRAM,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM_PROGRAM,
        }
        .to_account_metas(None);
        accounts.extend(extra);
        let ix = Instruction { program_id: ID, accounts, data: isolated_loan_v2::instruction::AcceptOffer {}.data() };
        self.send(ix, b)
    }

    fn open_loan(&mut self, id: u64, policy: u8) -> Pubkey {
        let o = self.create(id, args(policy), Pubkey::default()).unwrap();
        let b = self.borrower.insecure_clone();
        self.accept_as(o, &b).unwrap();
        o
    }

    fn repay(&mut self, offer: Pubkey, amount: u64) -> Result<(), String> {
        self.repay_with(offer, amount, WSOL_MINT)
    }

    fn repay_with(&mut self, offer: Pubkey, amount: u64, mint: Pubkey) -> Result<(), String> {
        let b = self.borrower.insecure_clone();
        let ix = Instruction {
            program_id: ID,
            accounts: isolated_loan_v2::accounts::Repay {
                borrower: b.pubkey(),
                offer,
                wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
                borrower_usdc: ata(b.pubkey(), USDC_MINT),
                lender: self.lender.pubkey(),
                lender_usdc: ata(self.lender.pubkey(), USDC_MINT),
                borrower_wsol: ata(b.pubkey(), mint),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan_v2::instruction::Repay { amount }.data(),
        };
        self.send(ix, &b)
    }

    fn add_collateral(&mut self, offer: Pubkey, amount: u64, signer: &Keypair) -> Result<(), String> {
        let ix = Instruction {
            program_id: ID,
            accounts: isolated_loan_v2::accounts::AddCollateral {
                borrower: signer.pubkey(),
                offer,
                wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
                borrower_wsol: ata(signer.pubkey(), WSOL_MINT),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan_v2::instruction::AddCollateral { amount }.data(),
        };
        self.send(ix, signer)
    }

    fn liquidation_accounts(&self, offer: Pubkey, caller: &Keypair) -> Vec<AccountMeta> {
        self.liquidation_accounts_with(offer, caller, WSOL_MINT, self.price, vec![])
    }

    fn liquidation_accounts_with(&self, offer: Pubkey, caller: &Keypair, mint: Pubkey, price: Pubkey, extra: Vec<AccountMeta>) -> Vec<AccountMeta> {
        let mut accounts = isolated_loan_v2::accounts::Liquidate {
            caller: caller.pubkey(),
            offer,
            price_update: price,
            wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
            caller_usdc: ata(caller.pubkey(), USDC_MINT),
            caller_wsol: ata(caller.pubkey(), mint),
            lender: self.lender.pubkey(),
            lender_usdc: ata(self.lender.pubkey(), USDC_MINT),
            borrower: self.borrower.pubkey(),
            borrower_wsol: ata(self.borrower.pubkey(), mint),
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None);
        accounts.extend(extra);
        accounts
    }

    fn liquidate(&mut self, offer: Pubkey, caller: &Keypair) -> Result<(), String> {
        let ix = Instruction { program_id: ID, accounts: self.liquidation_accounts(offer, caller), data: isolated_loan_v2::instruction::Liquidate {}.data() };
        self.send(ix, caller)
    }

    fn liquidate_overdue(&mut self, offer: Pubkey, caller: &Keypair) -> Result<(), String> {
        let ix = Instruction { program_id: ID, accounts: self.liquidation_accounts(offer, caller), data: isolated_loan_v2::instruction::LiquidateOverdue {}.data() };
        self.send(ix, caller)
    }

    fn lender_claim(&mut self, offer: Pubkey, signer: &Keypair, terminal: bool, price: Pubkey) -> Result<(), String> {
        self.lender_claim_with(offer, signer, terminal, price, WSOL_MINT, vec![])
    }

    fn lender_claim_with(&mut self, offer: Pubkey, signer: &Keypair, terminal: bool, price: Pubkey, mint: Pubkey, extra: Vec<AccountMeta>) -> Result<(), String> {
        let mut accounts = isolated_loan_v2::accounts::LenderClaim {
            lender: signer.pubkey(),
            offer,
            price_update: price,
            wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
            lender_wsol: ata(signer.pubkey(), mint),
            borrower: self.borrower.pubkey(),
            borrower_wsol: ata(self.borrower.pubkey(), mint),
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None);
        accounts.extend(extra);
        let data = if terminal { isolated_loan_v2::instruction::ClaimTerminal {}.data() } else { isolated_loan_v2::instruction::ClaimPricedRecovery {}.data() };
        self.send(Instruction { program_id: ID, accounts, data }, signer)
    }

    fn close(&mut self, offer: Pubkey) -> Result<(), String> {
        let l = self.lender.insecure_clone();
        let ix = Instruction {
            program_id: ID,
            accounts: isolated_loan_v2::accounts::CloseOffer { lender: l.pubkey(), offer }.to_account_metas(None),
            data: isolated_loan_v2::instruction::CloseOffer {}.data(),
        };
        self.send(ix, &l)
    }

    /// Story 26.1: `b` moves `old` into the open offer `new`, signing for at most `max` USDC.
    #[allow(clippy::too_many_arguments)]
    fn refinance_with(&mut self, old: Pubkey, new: Pubkey, b: &Keypair, max: u64, mint: Pubkey, price: Pubkey, extra: Vec<AccountMeta>) -> Result<(), String> {
        let (o, n) = (self.offer(old), self.offer(new));
        let mut accounts = isolated_loan_v2::accounts::RefinanceInto {
            borrower: b.pubkey(),
            old_offer: old,
            old_wsol_vault: pda(&[WSOL_VAULT_SEED, old.as_ref()]),
            old_lender: o.current_lender,
            old_lender_usdc: ata(o.current_lender, USDC_MINT),
            new_offer: new,
            new_lender: n.origin_lender,
            new_usdc_vault: pda(&[USDC_VAULT_SEED, new.as_ref()]),
            wsol_mint: mint,
            new_wsol_vault: pda(&[WSOL_VAULT_SEED, new.as_ref()]),
            borrower_usdc: ata(b.pubkey(), USDC_MINT),
            borrower_wsol: ata(b.pubkey(), mint),
            price_update: price,
            token_program: TOKEN_PROGRAM,
            system_program: SYSTEM_PROGRAM,
        }
        .to_account_metas(None);
        accounts.extend(extra);
        let ix = Instruction { program_id: ID, accounts, data: isolated_loan_v2::instruction::RefinanceInto { max_contribution: max }.data() };
        self.send(ix, b)
    }

    fn refinance(&mut self, old: Pubkey, new: Pubkey, max: u64) -> Result<(), String> {
        let (b, price) = (self.borrower.insecure_clone(), self.price);
        self.refinance_with(old, new, &b, max, WSOL_MINT, price, vec![])
    }

    /// Repays `offer` to `lender` (the loan's current lender) from the main borrower.
    fn repay_to(&mut self, offer: Pubkey, amount: u64, lender: Pubkey, mint: Pubkey) -> Result<(), String> {
        let b = self.borrower.insecure_clone();
        let ix = Instruction {
            program_id: ID,
            accounts: isolated_loan_v2::accounts::Repay {
                borrower: b.pubkey(),
                offer,
                wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
                borrower_usdc: ata(b.pubkey(), USDC_MINT),
                lender,
                lender_usdc: ata(lender, USDC_MINT),
                borrower_wsol: ata(b.pubkey(), mint),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan_v2::instruction::Repay { amount }.data(),
        };
        self.send(ix, &b)
    }

    fn terms(&self, offer: Pubkey) -> acc::TermsV2 {
        self.offer(offer).terms.core().unwrap()
    }
}

// --------------------------------------------------------------------------------------------

#[test]
fn accept_checks_ltv_against_maximum_exposure() {
    let mut env = Env::new();
    // 1.001001002 wSOL covers 105 USDC at 70% (the V1 rule) but not the 106 USDC maximum exposure.
    let mut a = args(1);
    a.collateral_amount = 1_001_001_002;
    let o = env.create(1, a, Pubkey::default()).unwrap();
    let b = env.borrower.insecure_clone();
    assert_err(env.accept_as(o, &b), LoanV2Error::InsufficientCollateral);
    let o = env.create(2, args(1), Pubkey::default()).unwrap();
    env.accept_as(o, &b).unwrap();
    let state = env.offer(o);
    assert_eq!(state.status, StatusV2::Active);
    assert_eq!(state.collateral_locked, COLLATERAL);
    assert_eq!(state.terms.start_ts, START);
}

#[test]
fn rejects_terms_above_the_ceiling_or_outside_caps() {
    let mut env = Env::new();
    let mut a = args(1);
    a.annual_ceiling_bps = 5_000; // 5% for 30 days is ~61% a year
    assert_err(env.create(1, a, Pubkey::default()).map(|_| ()), LoanV2Error::InvalidTerms);
    let mut a = args(1);
    a.grace_seconds = DAY - 1;
    assert_err(env.create(2, a, Pubkey::default()).map(|_| ()), LoanV2Error::InvalidTerms);
    let mut a = args(1);
    a.late_fee_bps = 501;
    assert_err(env.create(3, a, Pubkey::default()).map(|_| ()), LoanV2Error::InvalidTerms);
}

#[test]
fn restricted_offer_accepts_only_its_borrower() {
    let mut env = Env::new();
    let b = env.borrower.insecure_clone();
    let s = env.stranger.insecure_clone();
    let o = env.create(1, args(1), b.pubkey()).unwrap();
    assert_err(env.accept_as(o, &s), LoanV2Error::RestrictedBorrower);
    env.accept_as(o, &b).unwrap();
}

#[test]
fn early_pro_rata_payoff_pays_the_minimum_and_returns_all_collateral() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let (lender0, borrower_wsol0) = (env.usdc(&env.lender.insecure_clone()), env.wsol(&env.borrower.insecure_clone()));
    env.at(START + DAY);
    assert_eq!(env.payoff(o), 101_250_000);
    // Paying more than the payoff takes only the payoff.
    env.repay(o, 200_000_000).unwrap();
    let state = env.offer(o);
    assert_eq!(state.status, StatusV2::Repaid);
    assert_eq!(env.usdc(&env.lender.insecure_clone()) - lender0, 101_250_000);
    assert_eq!(env.wsol(&env.borrower.insecure_clone()) - borrower_wsol0, COLLATERAL);
    assert!(!env.exists(pda(&[WSOL_VAULT_SEED, o.as_ref()])));
    env.close(o).unwrap();
}

#[test]
fn full_term_owes_full_interest_early() {
    let mut env = Env::new();
    let o = env.open_loan(1, 0);
    env.at(START + 60);
    assert_eq!(env.payoff(o), 105_000_000);
}

#[test]
fn partials_and_top_up_keep_accounting_and_deadline() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let maturity = env.terms(o).maturity();
    let lender = env.lender.insecure_clone();
    let l0 = env.usdc(&lender);
    env.at(START + 10 * DAY);
    env.repay(o, 30_000_000).unwrap();
    let s = env.offer(o);
    assert_eq!(s.status, StatusV2::Active);
    assert_eq!(s.ledger.interest_paid, 1_666_666);
    assert_eq!(s.ledger.outstanding_principal, 100_000_000 - (30_000_000 - 1_666_666));
    assert_eq!(env.terms(o).maturity(), maturity, "a payment never moves the deadline");
    let b = env.borrower.insecure_clone();
    let s0 = env.stranger.insecure_clone();
    assert_err(env.add_collateral(o, 1, &s0), LoanV2Error::UnauthorizedBorrower);
    env.add_collateral(o, 500_000_000, &b).unwrap();
    assert_eq!(env.offer(o).collateral_locked, COLLATERAL + 500_000_000);
    // In grace the late fee applies and repayment still works.
    env.at(maturity + 3_600);
    let payoff = env.payoff(o);
    env.repay(o, payoff).unwrap();
    assert_eq!(env.offer(o).status, StatusV2::Repaid);
    assert_eq!(env.usdc(&lender) - l0, 30_000_000 + payoff);
    assert_eq!(env.wsol(&b), 10_000_000_000, "every wSOL atom came back");
}

#[test]
fn overdue_liquidation_opens_exactly_at_grace_end_and_returns_surplus() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let t = env.terms(o);
    let s = env.stranger.insecure_clone();
    env.at(t.maturity());
    env.price_usd(150, 150);
    assert_err(env.liquidate_overdue(o, &s), LoanV2Error::TooEarly);
    env.at(t.grace_end() - 1);
    env.price_usd(150, 150);
    assert_err(env.liquidate_overdue(o, &s), LoanV2Error::TooEarly);
    env.at(t.grace_end());
    env.price_usd(150, 150);
    let payoff = env.payoff(o);
    let (caller_usdc, caller_wsol, b_wsol, l_usdc) = (env.usdc(&s), env.wsol(&s), env.wsol(&env.borrower.insecure_clone()), env.usdc(&env.lender.insecure_clone()));
    env.liquidate_overdue(o, &s).unwrap();
    let value = loan_core::math::collateral_value_usdc(COLLATERAL, 150 * USD, (150 * USD / 1000) as u64, -8).unwrap();
    let split = acc::liquidation_split(payoff, COLLATERAL, value).unwrap();
    assert_eq!(caller_usdc - env.usdc(&s), payoff);
    assert_eq!(env.usdc(&env.lender.insecure_clone()) - l_usdc, payoff);
    assert_eq!(env.wsol(&s) - caller_wsol, split.to_recipient);
    assert_eq!(env.wsol(&env.borrower.insecure_clone()) - b_wsol, split.to_borrower);
    assert!(split.to_borrower > 0, "surplus returns to the borrower");
    assert_eq!(env.offer(o).status, StatusV2::OverdueLiquidated);
}

#[test]
fn borrower_cannot_liquidate_their_own_loan() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let t = env.terms(o);
    env.at(t.grace_end());
    env.price_usd(150, 150);
    let b = env.borrower.insecure_clone();
    let before = env.wsol(&b);
    // The borrower's wSOL account would be both caller and borrower destination; either guard stops it.
    assert_rejected(env.liquidate_overdue(o, &b), &[DUPLICATE, &code(LoanV2Error::BorrowerCannotLiquidate)]);
    assert_eq!(env.offer(o).status, StatusV2::Active);
    assert_eq!(env.wsol(&b), before);
}

#[test]
fn risk_liquidation_needs_spot_and_ema_or_an_emergency_margin() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let s = env.stranger.insecure_clone();
    env.at(START + DAY);
    // Spot past the line but the average still healthy: wick protection holds.
    env.price_usd(120, 150);
    assert_err(env.liquidate(o, &s), LoanV2Error::LoanHealthy);
    // Spot three points further past the line: emergency.
    env.price_usd(119, 150);
    env.liquidate(o, &s).unwrap();
    assert_eq!(env.offer(o).status, StatusV2::Liquidated);

    env.price_usd(150, 150);
    let o2 = env.open_loan(2, 1);
    env.price_usd(120, 120);
    env.liquidate(o2, &s).unwrap();
    assert_eq!(env.offer(o2).status, StatusV2::Liquidated);
}

#[test]
fn risk_liquidation_is_closed_after_grace_in_favour_of_overdue() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let t = env.terms(o);
    let s = env.stranger.insecure_clone();
    env.at(t.grace_end());
    env.price_usd(100, 100);
    assert_err(env.liquidate(o, &s), LoanV2Error::WrongStatus);
    env.liquidate_overdue(o, &s).unwrap();
}

#[test]
fn stale_price_blocks_priced_paths_but_not_the_terminal_claim() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let t = env.terms(o);
    let s = env.stranger.insecure_clone();
    let l = env.lender.insecure_clone();
    env.at(t.grace_end());
    env.post(150 * USD, 150_000, 150 * USD, 150_000, t.grace_end() - 61);
    assert_err(env.liquidate_overdue(o, &s), LoanV2Error::StalePrice);
    env.at(t.terminal_claim_from() - 1);
    assert_err(env.lender_claim(o, &l, true, env.price), LoanV2Error::TooEarly);
    env.at(t.terminal_claim_from());
    let l0 = env.wsol(&l);
    // Any account works as the price: the terminal claim reads none.
    env.lender_claim(o, &l, true, Pubkey::new_unique()).unwrap();
    assert_eq!(env.wsol(&l) - l0, COLLATERAL);
    assert_eq!(env.offer(o).status, StatusV2::TerminalClaimed);
}

#[test]
fn priced_recovery_returns_surplus_or_records_shortfall() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let t = env.terms(o);
    let l = env.lender.insecure_clone();
    env.at(t.priced_recovery_from() - 1);
    env.price_usd(150, 150);
    assert_err(env.lender_claim(o, &l, false, env.price), LoanV2Error::TooEarly);
    env.at(t.priced_recovery_from());
    env.price_usd(150, 150);
    let b0 = env.wsol(&env.borrower.insecure_clone());
    let payoff = env.payoff(o);
    env.lender_claim(o, &l, false, env.price).unwrap();
    let value = loan_core::math::collateral_value_usdc(COLLATERAL, 150 * USD, (150 * USD / 1000) as u64, -8).unwrap();
    let split = acc::priced_recovery_split(payoff, COLLATERAL, value).unwrap();
    assert_eq!(env.wsol(&env.borrower.insecure_clone()) - b0, split.to_borrower);
    assert_eq!(env.offer(o).status, StatusV2::PricedRecovered);
    assert_eq!(env.offer(o).shortfall, 0);

    // A collapsed price: the lender gets everything and the gap is recorded.
    let o2 = env.open_loan(2, 1);
    let t2 = env.terms(o2);
    env.at(t2.priced_recovery_from());
    env.price_usd(50, 50);
    let payoff = env.payoff(o2);
    env.lender_claim(o2, &l, false, env.price).unwrap();
    let value = loan_core::math::collateral_value_usdc(COLLATERAL, 50 * USD, (50 * USD / 1000) as u64, -8).unwrap();
    assert_eq!(env.offer(o2).shortfall, payoff - value);
}

#[test]
fn only_the_lender_claims_and_repayment_stays_open_until_settlement() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let t = env.terms(o);
    let s = env.stranger.insecure_clone();
    env.at(t.terminal_claim_from() + DAY);
    assert_err(env.lender_claim(o, &s, true, env.price), LoanV2Error::UnauthorizedLender);
    // Even this late, the borrower can still repay and keep everything.
    let payoff = env.payoff(o);
    env.repay(o, payoff).unwrap();
    assert_eq!(env.offer(o).status, StatusV2::Repaid);
    let l = env.lender.insecure_clone();
    let l0 = env.wsol(&l);
    assert_rejected(env.lender_claim(o, &l, true, env.price), &[CLOSED_VAULT, &code(LoanV2Error::WrongStatus)]);
    assert_eq!(env.offer(o).status, StatusV2::Repaid);
    assert_eq!(env.wsol(&l), l0);
}

#[test]
fn a_settled_loan_cannot_be_settled_again() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let t = env.terms(o);
    let l = env.lender.insecure_clone();
    let s = env.stranger.insecure_clone();
    env.at(t.terminal_claim_from());
    env.lender_claim(o, &l, true, env.price).unwrap();
    env.price_usd(150, 150);
    let either = [CLOSED_VAULT, &code(LoanV2Error::WrongStatus)];
    let b = env.borrower.insecure_clone();
    let (b_usdc, s_usdc) = (env.usdc(&b), env.usdc(&s));
    assert_rejected(env.repay(o, u64::MAX), &either);
    assert_rejected(env.liquidate_overdue(o, &s), &either);
    assert_rejected(env.lender_claim(o, &l, false, env.price), &either);
    assert_eq!(env.offer(o).status, StatusV2::TerminalClaimed);
    assert_eq!((env.usdc(&b), env.usdc(&s)), (b_usdc, s_usdc));
    env.close(o).unwrap();
    assert!(!env.exists(o));
}

#[test]
fn open_offers_cancel_and_cannot_close_early() {
    let mut env = Env::new();
    let o = env.create(1, args(1), Pubkey::default()).unwrap();
    assert_err(env.close(o), LoanV2Error::NotSettled);
    let l = env.lender.insecure_clone();
    let l0 = env.usdc(&l);
    let ix = Instruction {
        program_id: ID,
        accounts: isolated_loan_v2::accounts::CancelOffer {
            lender: l.pubkey(),
            offer: o,
            usdc_vault: pda(&[USDC_VAULT_SEED, o.as_ref()]),
            lender_usdc: ata(l.pubkey(), USDC_MINT),
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None),
        data: isolated_loan_v2::instruction::CancelOffer {}.data(),
    };
    env.send(ix, &l).unwrap();
    assert_eq!(env.usdc(&l) - l0, PRINCIPAL);
    assert_eq!(env.offer(o).status, StatusV2::Cancelled);
    env.close(o).unwrap();
}

#[test]
fn request_funding_creates_an_active_v2_loan() {
    let mut env = Env::new();
    let b = env.borrower.insecure_clone();
    let l = env.lender.insecure_clone();
    let request = pda(&[REQUEST_SEED, b.pubkey().as_ref(), &7u64.to_le_bytes()]);
    let vault = pda(&[REQUEST_WSOL_VAULT_SEED, request.as_ref()]);
    let ix = Instruction {
        program_id: ID,
        accounts: isolated_loan_v2::accounts::CreateRequest {
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
        .to_account_metas(None),
        data: isolated_loan_v2::instruction::CreateRequest { request_id: 7, args: args(1) }.data(),
    };
    env.send(ix, &b).unwrap();
    assert_eq!(env.balance(vault), COLLATERAL);
    let offer = offer_pda(l.pubkey(), 9);
    let b_usdc0 = env.usdc(&b);
    let ix = Instruction {
        program_id: ID,
        accounts: isolated_loan_v2::accounts::FundRequest {
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
        .to_account_metas(None),
        data: isolated_loan_v2::instruction::FundRequest { offer_id: 9 }.data(),
    };
    env.send(ix, &l).unwrap();
    assert_eq!(env.usdc(&b) - b_usdc0, PRINCIPAL);
    let state = env.offer(offer);
    assert_eq!(state.status, StatusV2::Active);
    assert_eq!(state.borrower, b.pubkey());
    assert_eq!(state.origin_lender, l.pubkey());
    assert_eq!(state.current_lender, l.pubkey());
    assert_eq!(env.request(request).status, RequestStatusV2::Funded);
    env.at(START + 5 * DAY);
    let p = env.payoff(offer);
    env.repay(offer, p).unwrap();
    assert_eq!(env.offer(offer).status, StatusV2::Repaid);
}

// ---- Story 26.2: per-asset collateral -------------------------------------------------------

fn jito_value(amount: u64, dollars: i64) -> u64 {
    loan_core::math::collateral_value_usdc_decimals(amount, 9, dollars * USD, (dollars * USD / 1000) as u64, -8).unwrap()
}

fn open_jito_loan(env: &mut Env, id: u64) -> Pubkey {
    let (jito, jp, extra) = (env.jito, env.jito_price, env.jito_extra());
    let o = env.create_with(id, jito_terms(), Pubkey::default(), jito, extra.clone()).unwrap();
    let b = env.borrower.insecure_clone();
    env.accept_with(o, &b, jito, jp, extra).unwrap();
    o
}

#[test]
fn jitosol_accept_and_repay() {
    let mut env = Env::new();
    env.configure_jito(true);
    env.jito_usd(180, 180);
    let (jito, jp, extra) = (env.jito, env.jito_price, env.jito_extra());
    let b = env.borrower.insecure_clone();
    let o = env.create_with(1, jito_terms(), Pubkey::default(), jito, extra.clone()).unwrap();
    // The accept needs the asset's config and its own feed: no config, or SOL/USD, fails closed.
    assert_err(env.accept_with(o, &b, jito, jp, vec![]), LoanV2Error::CollateralNotConfigured);
    let sol_price = env.price;
    assert_err(env.accept_with(o, &b, jito, sol_price, extra.clone()), LoanV2Error::InvalidFeedId);
    let b_jito0 = env.balance(ata(b.pubkey(), jito));
    env.accept_with(o, &b, jito, jp, extra).unwrap();
    let s = env.offer(o);
    assert_eq!((s.status, s.wsol_mint, s.collateral_locked), (StatusV2::Active, jito, JITO_COLLATERAL));
    assert_eq!(b_jito0 - env.balance(ata(b.pubkey(), jito)), JITO_COLLATERAL);
    assert_eq!(env.balance(pda(&[WSOL_VAULT_SEED, o.as_ref()])), JITO_COLLATERAL);
    env.at(START + 5 * DAY);
    let payoff = env.payoff(o);
    env.repay_with(o, payoff, jito).unwrap();
    assert_eq!(env.offer(o).status, StatusV2::Repaid);
    assert_eq!(env.balance(ata(b.pubkey(), jito)), b_jito0, "every jitoSOL atom came back");
}

#[test]
fn jitosol_origination_uses_the_asset_caps_and_price() {
    let mut env = Env::new();
    env.configure_jito(true);
    let (jito, jp, extra) = (env.jito, env.jito_price, env.jito_extra());
    let b = env.borrower.insecure_clone();
    // wSOL's 70% / 80% terms are above jitoSOL's 60% / 70% caps.
    let mut a = jito_terms();
    a.max_ltv_bps = MAX_LTV;
    a.liquidation_ltv_bps = LIQ_LTV;
    assert_err(env.create_with(1, a, Pubkey::default(), jito, extra.clone()).map(|_| ()), LoanV2Error::InvalidTerms);
    // At 100 a jitoSOL, 1.1 jitoSOL (~109.89 USDC) cannot carry 106 USDC of exposure at 60%.
    env.jito_usd(100, 100);
    let o = env.create_with(2, jito_terms(), Pubkey::default(), jito, extra.clone()).unwrap();
    assert_err(env.accept_with(o, &b, jito, jp, extra.clone()), LoanV2Error::InsufficientCollateral);
    env.jito_usd(180, 180);
    env.accept_with(o, &b, jito, jp, extra).unwrap();
}

#[test]
fn jitosol_liquidation_reads_its_own_feed() {
    let mut env = Env::new();
    env.configure_jito(true);
    env.jito_usd(180, 180);
    let o = open_jito_loan(&mut env, 1);
    let (jito, jp, extra) = (env.jito, env.jito_price, env.jito_extra());
    let s = env.stranger.insecure_clone();
    env.at(START + DAY);
    let liquidate = |env: &mut Env, price: Pubkey, extra: Vec<AccountMeta>| {
        let ix = Instruction { program_id: ID, accounts: env.liquidation_accounts_with(o, &s, jito, price, extra), data: isolated_loan_v2::instruction::Liquidate {}.data() };
        env.send(ix, &s)
    };
    // 150 a jitoSOL is ~61% LTV: healthy against the 70% line.
    env.jito_usd(150, 150);
    assert_err(liquidate(&mut env, jp, extra.clone()), LoanV2Error::LoanHealthy);
    // SOL/USD collapsing says nothing about jitoSOL, and the config cannot be skipped.
    env.price_usd(10, 10);
    let sol_price = env.price;
    assert_err(liquidate(&mut env, sol_price, extra.clone()), LoanV2Error::InvalidFeedId);
    env.jito_usd(120, 120);
    assert_err(liquidate(&mut env, jp, vec![]), LoanV2Error::CollateralNotConfigured);
    // Disabling the asset stops new loans, never the liquidation of existing ones.
    let g = env.governance.insecure_clone();
    env.set_collateral(&g, jito, jito_args(false)).unwrap();
    let payoff = env.payoff(o);
    let (caller0, borrower0) = (env.balance(ata(s.pubkey(), jito)), env.balance(ata(env.borrower.pubkey(), jito)));
    liquidate(&mut env, jp, extra).unwrap();
    let split = acc::liquidation_split(payoff, JITO_COLLATERAL, jito_value(JITO_COLLATERAL, 120)).unwrap();
    assert_eq!(env.balance(ata(s.pubkey(), jito)) - caller0, split.to_recipient);
    assert_eq!(env.balance(ata(env.borrower.pubkey(), jito)) - borrower0, split.to_borrower);
    assert!(split.to_borrower > 0);
    assert_eq!(env.offer(o).status, StatusV2::Liquidated);
}

#[test]
fn jitosol_priced_recovery_reads_its_own_feed() {
    let mut env = Env::new();
    env.configure_jito(true);
    env.jito_usd(180, 180);
    let o = open_jito_loan(&mut env, 1);
    let (jito, jp, extra) = (env.jito, env.jito_price, env.jito_extra());
    let l = env.lender.insecure_clone();
    let t = env.terms(o);
    env.at(t.priced_recovery_from());
    env.jito_usd(180, 180);
    env.price_usd(150, 150);
    let sol_price = env.price;
    assert_err(env.lender_claim_with(o, &l, false, sol_price, jito, extra.clone()), LoanV2Error::InvalidFeedId);
    let payoff = env.payoff(o);
    let l0 = env.balance(ata(l.pubkey(), jito));
    env.lender_claim_with(o, &l, false, jp, jito, extra).unwrap();
    let split = acc::priced_recovery_split(payoff, JITO_COLLATERAL, jito_value(JITO_COLLATERAL, 180)).unwrap();
    assert_eq!(env.balance(ata(l.pubkey(), jito)) - l0, split.to_recipient);
    assert_eq!(env.offer(o).status, StatusV2::PricedRecovered);
}

#[test]
fn jitosol_request_funding_uses_the_config() {
    let mut env = Env::new();
    env.configure_jito(true);
    env.jito_usd(180, 180);
    let (jito, jp, extra) = (env.jito, env.jito_price, env.jito_extra());
    let b = env.borrower.insecure_clone();
    let l = env.lender.insecure_clone();
    let request = pda(&[REQUEST_SEED, b.pubkey().as_ref(), &3u64.to_le_bytes()]);
    let vault = pda(&[REQUEST_WSOL_VAULT_SEED, request.as_ref()]);
    let create = |env: &mut Env, extra: Vec<AccountMeta>| {
        let mut accounts = isolated_loan_v2::accounts::CreateRequest {
            borrower: b.pubkey(),
            request,
            usdc_mint: USDC_MINT,
            wsol_mint: jito,
            request_vault: vault,
            borrower_wsol: ata(b.pubkey(), jito),
            borrower_usdc: ata(b.pubkey(), USDC_MINT),
            token_program: TOKEN_PROGRAM,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM_PROGRAM,
        }
        .to_account_metas(None);
        accounts.extend(extra);
        env.send(Instruction { program_id: ID, accounts, data: isolated_loan_v2::instruction::CreateRequest { request_id: 3, args: jito_terms() }.data() }, &b)
    };
    assert_err(create(&mut env, vec![]), LoanV2Error::CollateralNotConfigured);
    create(&mut env, extra.clone()).unwrap();
    let offer = offer_pda(l.pubkey(), 4);
    let fund = |env: &mut Env, extra: Vec<AccountMeta>| {
        let mut accounts = isolated_loan_v2::accounts::FundRequest {
            lender: l.pubkey(),
            request,
            borrower: b.pubkey(),
            price_update: jp,
            offer,
            wsol_mint: jito,
            request_vault: vault,
            wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
            lender_usdc: ata(l.pubkey(), USDC_MINT),
            borrower_usdc: ata(b.pubkey(), USDC_MINT),
            token_program: TOKEN_PROGRAM,
            system_program: SYSTEM_PROGRAM,
        }
        .to_account_metas(None);
        accounts.extend(extra);
        env.send(Instruction { program_id: ID, accounts, data: isolated_loan_v2::instruction::FundRequest { offer_id: 4 }.data() }, &l)
    };
    let g = env.governance.insecure_clone();
    env.set_collateral(&g, jito, jito_args(false)).unwrap();
    assert_err(fund(&mut env, extra.clone()), LoanV2Error::CollateralDisabled);
    env.set_collateral(&g, jito, jito_args(true)).unwrap();
    fund(&mut env, extra).unwrap();
    let s = env.offer(offer);
    assert_eq!((s.status, s.wsol_mint, s.collateral_locked), (StatusV2::Active, jito, JITO_COLLATERAL));
}

#[test]
fn unconfigured_mint_is_rejected() {
    let mut env = Env::new();
    let jito = env.jito;
    // No config at all.
    assert_err(env.create_with(1, jito_terms(), Pubkey::default(), jito, vec![]).map(|_| ()), LoanV2Error::CollateralNotConfigured);
    // Another asset's config cannot stand in for this mint.
    let other = Pubkey::new_unique();
    env.put_mint(other, 9);
    let g = env.governance.insecure_clone();
    env.set_collateral(&g, other, jito_args(true)).unwrap();
    let wrong = vec![AccountMeta::new_readonly(Env::collateral_pda(other), false)];
    assert_err(env.create_with(2, jito_terms(), Pubkey::default(), jito, wrong).map(|_| ()), LoanV2Error::CollateralNotConfigured);
    // Nor can an account this program does not own.
    let fake = Pubkey::new_unique();
    env.put(fake, SYSTEM_PROGRAM, vec![0; 120]);
    let fake = vec![AccountMeta::new_readonly(fake, false)];
    assert_err(env.create_with(3, jito_terms(), Pubkey::default(), jito, fake).map(|_| ()), LoanV2Error::CollateralNotConfigured);
}

#[test]
fn disabled_config_is_rejected_for_new_loans() {
    let mut env = Env::new();
    env.jito_usd(180, 180);
    let (jito, jp, extra) = (env.jito, env.jito_price, env.jito_extra());
    env.configure_jito(false);
    assert_err(env.create_with(1, jito_terms(), Pubkey::default(), jito, extra.clone()).map(|_| ()), LoanV2Error::CollateralDisabled);
    // An offer created while enabled cannot be accepted after governance disables the asset.
    env.configure_jito(true);
    let o = env.create_with(2, jito_terms(), Pubkey::default(), jito, extra.clone()).unwrap();
    env.configure_jito(false);
    let b = env.borrower.insecure_clone();
    assert_err(env.accept_with(o, &b, jito, jp, extra), LoanV2Error::CollateralDisabled);
}

#[test]
fn only_governance_writes_collateral_config() {
    let mut env = Env::new();
    let (jito, g, s) = (env.jito, env.governance.insecure_clone(), env.stranger.insecure_clone());
    assert_err(env.set_collateral(&s, jito, jito_args(true)), LoanV2Error::WrongAuthority);
    assert!(!env.exists(Env::collateral_pda(jito)));
    // Canonical wSOL keeps its constants and never gets a config; USDC is not collateral.
    assert_err(env.set_collateral(&g, WSOL_MINT, jito_args(true)), LoanV2Error::InvalidCollateralConfig);
    assert_err(env.set_collateral(&g, USDC_MINT, jito_args(true)), LoanV2Error::InvalidCollateralConfig);
    // Caps stay inside the global caps with the 5-point gap, and a feed is required.
    let mut bad = jito_args(true);
    bad.liquidation_ltv_bps = JITO_MAX_LTV + 499;
    assert_err(env.set_collateral(&g, jito, bad), LoanV2Error::InvalidCollateralConfig);
    let mut bad = jito_args(true);
    bad.max_ltv_bps = 7_001;
    assert_err(env.set_collateral(&g, jito, bad), LoanV2Error::InvalidCollateralConfig);
    let mut bad = jito_args(true);
    bad.feed_id = [0; 32];
    assert_err(env.set_collateral(&g, jito, bad), LoanV2Error::InvalidCollateralConfig);
    env.set_collateral(&g, jito, jito_args(true)).unwrap();
    let read = |env: &Env| CollateralConfig::try_deserialize(&mut &env.svm.get_account(&Env::collateral_pda(jito)).unwrap().data[..]).unwrap();
    let c = read(&env);
    assert_eq!((c.version, c.mint, c.decimals, c.feed_id, c.max_ltv_bps, c.liquidation_ltv_bps, c.enabled), (1, jito, 9, JITOSOL_USD_FEED_ID, JITO_MAX_LTV, JITO_LIQ_LTV, true));
    // Updates also need governance.
    assert_err(env.set_collateral(&s, jito, jito_args(false)), LoanV2Error::WrongAuthority);
    env.set_collateral(&g, jito, jito_args(false)).unwrap();
    assert!(!read(&env).enabled);
}

#[test]
fn wsol_path_is_unchanged_by_collateral_configs() {
    let mut env = Env::new();
    env.configure_jito(true);
    env.jito_usd(10, 10);
    // wSOL ignores any config passed with it: SOL/USD prices it, and wSOL's own 70% / 80% caps
    // (not jitoSOL's 60% / 70%) apply.
    let extra = env.jito_extra();
    let o = env.create_with(1, args(1), Pubkey::default(), WSOL_MINT, extra.clone()).unwrap();
    let b = env.borrower.insecure_clone();
    let jp = env.jito_price;
    assert_err(env.accept_with(o, &b, WSOL_MINT, jp, extra.clone()), LoanV2Error::InvalidFeedId);
    let sol_price = env.price;
    env.accept_with(o, &b, WSOL_MINT, sol_price, extra).unwrap();
    let s = env.offer(o);
    assert_eq!((s.status, s.max_ltv_bps, s.liquidation_ltv_bps), (StatusV2::Active, MAX_LTV, LIQ_LTV));
    // The SOL valuation is the 9-decimal valuation, so wSOL liquidation splits are unchanged.
    assert_eq!(
        loan_core::math::collateral_value_usdc_decimals(COLLATERAL, 9, 150 * USD, (150 * USD / 1000) as u64, -8).unwrap(),
        loan_core::math::collateral_value_usdc(COLLATERAL, 150 * USD, (150 * USD / 1000) as u64, -8).unwrap()
    );
}

// ---- Story 26.1: refinance and rollover -----------------------------------------------------

/// An open offer from `lender` with `principal` and `collateral`, otherwise the default terms.
fn offer_from(env: &mut Env, lender: &Keypair, id: u64, principal: u64, collateral: u64, restricted: Pubkey) -> Pubkey {
    let a = TermsArgs { principal, collateral_amount: collateral, ..args(1) };
    env.create_by(lender, id, a, restricted, WSOL_MINT, vec![]).unwrap()
}

#[test]
fn refinance_pays_the_old_lender_exactly_the_payoff_with_a_contribution() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let (l, b, s) = (env.lender.insecure_clone(), env.borrower.insecure_clone(), env.stranger.insecure_clone());
    let n = offer_from(&mut env, &s, 7, 90_000_000, 950_000_000, Pubkey::default());
    env.at(START + DAY);
    env.price_usd(150, 150);
    let payoff = env.payoff(o);
    assert_eq!(payoff, 101_250_000);
    let contribution = payoff - 90_000_000;
    // The borrower's signed bound is enforced.
    assert_err(env.refinance(o, n, contribution - 1), LoanV2Error::PaymentAboveLimit);
    let (l0, b0, s0, bw0) = (env.usdc(&l), env.usdc(&b), env.usdc(&s), env.wsol(&b));
    env.refinance(o, n, contribution).unwrap();

    assert_eq!(env.usdc(&l) - l0, payoff, "the old lender receives exactly payoff_old");
    assert_eq!(b0 - env.usdc(&b), contribution, "the borrower pays only the contribution");
    assert_eq!(env.usdc(&s), s0, "the new principal left the new lender at create");
    assert_eq!(env.wsol(&b) - bw0, COLLATERAL - 950_000_000, "collateral above the new requirement comes back");

    let old = env.offer(o);
    assert_eq!((old.status, old.settled_ts, old.collateral_locked), (StatusV2::Refinanced, START + DAY, 0));
    assert_eq!(old.ledger.outstanding_principal, 0);
    assert!(old.status.is_settled() && old.status != StatusV2::Repaid);
    assert!(!env.exists(pda(&[WSOL_VAULT_SEED, o.as_ref()])));

    let new = env.offer(n);
    assert_eq!((new.status, new.borrower, new.current_lender), (StatusV2::Active, b.pubkey(), s.pubkey()));
    assert_eq!((new.terms.start_ts, new.collateral_locked, new.ledger.outstanding_principal), (START + DAY, 950_000_000, 90_000_000));
    assert_eq!(env.balance(pda(&[WSOL_VAULT_SEED, n.as_ref()])), 950_000_000);
    assert!(!env.exists(pda(&[USDC_VAULT_SEED, n.as_ref()])));
    // The old lender can close the settled account.
    env.close(o).unwrap();
}

#[test]
fn same_lender_rollover_in_grace_with_no_contribution_and_a_top_up() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let (l, b) = (env.lender.insecure_clone(), env.borrower.insecure_clone());
    env.at(env.terms(o).maturity() + 3_600);
    env.price_usd(150, 150);
    let payoff = env.payoff(o);
    assert_eq!(payoff, 106_000_000, "full interest plus the one-time late fee");
    // A renewal offer restricted to this borrower, for exactly the payoff.
    let l0 = env.usdc(&l);
    let n = offer_from(&mut env, &l, 2, payoff, 1_100_000_000, b.pubkey());
    let (b0, bw0) = (env.usdc(&b), env.wsol(&b));
    env.refinance(o, n, 0).unwrap();
    assert_eq!(env.usdc(&l), l0, "the lender's new principal paid off its own old loan");
    assert_eq!(env.usdc(&b), b0, "zero contribution");
    assert_eq!(bw0 - env.wsol(&b), 80_000_000, "the borrower tops up to the new requirement");
    assert_eq!(env.offer(o).status, StatusV2::Refinanced);
    let new = env.offer(n);
    assert_eq!((new.status, new.collateral_locked, new.terms.principal), (StatusV2::Active, 1_100_000_000, payoff));
    assert_eq!(env.balance(pda(&[WSOL_VAULT_SEED, n.as_ref()])), 1_100_000_000);
}

#[test]
fn refinance_never_pays_cash_out() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let s = env.stranger.insecure_clone();
    let n = offer_from(&mut env, &s, 7, 101_250_001, COLLATERAL, Pubkey::default());
    env.at(START + DAY);
    env.price_usd(150, 150);
    assert_err(env.refinance(o, n, u64::MAX), LoanV2Error::RefinanceCashOut);
    assert_eq!(env.offer(o).status, StatusV2::Active);
    assert_eq!(env.offer(n).status, StatusV2::Open);
}

#[test]
fn refinance_closes_exactly_when_grace_ends() {
    let mut env = Env::new();
    let first = env.open_loan(1, 1);
    let second = env.open_loan(2, 1);
    let s = env.stranger.insecure_clone();
    let n1 = offer_from(&mut env, &s, 10, 50_000_000, COLLATERAL, Pubkey::default());
    let n2 = offer_from(&mut env, &s, 11, 50_000_000, COLLATERAL, Pubkey::default());
    let grace_end = env.terms(first).grace_end();
    env.at(grace_end - 1);
    env.price_usd(150, 150);
    env.refinance(first, n1, u64::MAX).unwrap();
    env.at(grace_end);
    env.price_usd(150, 150);
    assert_err(env.refinance(second, n2, u64::MAX), LoanV2Error::RefinanceClosed);
    assert_eq!(env.offer(second).status, StatusV2::Active);
}

#[test]
fn a_restricted_renewal_rejects_another_borrower() {
    let mut env = Env::new();
    let (l, b, s) = (env.lender.insecure_clone(), env.borrower.insecure_clone(), env.stranger.insecure_clone());
    let theirs = env.create(1, args(1), Pubkey::default()).unwrap();
    env.accept_as(theirs, &s).unwrap();
    let mine = env.open_loan(2, 1);
    let renewal = offer_from(&mut env, &l, 3, PRINCIPAL, COLLATERAL, b.pubkey());
    env.at(START + DAY);
    env.price_usd(150, 150);
    let price = env.price;
    assert_err(env.refinance_with(theirs, renewal, &s, u64::MAX, WSOL_MINT, price, vec![]), LoanV2Error::RestrictedBorrower);
    // Nobody refinances a loan they did not borrow.
    assert_err(env.refinance_with(mine, renewal, &s, u64::MAX, WSOL_MINT, price, vec![]), LoanV2Error::UnauthorizedBorrower);
    env.refinance(mine, renewal, u64::MAX).unwrap();
    assert_eq!(env.offer(renewal).borrower, b.pubkey());
}

#[test]
fn refinance_racing_repay_and_liquidation_yields_one_terminal_state() {
    let mut env = Env::new();
    let s = env.stranger.insecure_clone();
    let refinanced = env.open_loan(1, 1);
    let repaid = env.open_loan(2, 1);
    let liquidated = env.open_loan(3, 1);
    let spare = offer_from(&mut env, &s, 20, 50_000_000, COLLATERAL, Pubkey::default());
    let n1 = offer_from(&mut env, &s, 21, 50_000_000, COLLATERAL, Pubkey::default());
    let n2 = offer_from(&mut env, &s, 22, 50_000_000, COLLATERAL, Pubkey::default());
    let n3 = offer_from(&mut env, &s, 23, 50_000_000, COLLATERAL, Pubkey::default());
    env.at(START + DAY);
    env.price_usd(150, 150);
    let either = [CLOSED_VAULT, &code(LoanV2Error::WrongStatus)];

    // Refinance first: repay, liquidation and a second refinance all fail.
    env.refinance(refinanced, n1, u64::MAX).unwrap();
    assert_rejected(env.repay(refinanced, u64::MAX), &either);
    assert_rejected(env.refinance(refinanced, spare, u64::MAX), &either);
    env.price_usd(100, 100);
    assert_rejected(env.liquidate(refinanced, &s), &either);
    assert_eq!(env.offer(refinanced).status, StatusV2::Refinanced);

    // Repay first: refinance fails.
    env.price_usd(150, 150);
    env.repay(repaid, u64::MAX).unwrap();
    assert_rejected(env.refinance(repaid, n2, u64::MAX), &either);
    assert_eq!(env.offer(repaid).status, StatusV2::Repaid);

    // Liquidation first: refinance fails.
    env.price_usd(100, 100);
    env.liquidate(liquidated, &s).unwrap();
    env.price_usd(150, 150);
    assert_rejected(env.refinance(liquidated, n3, u64::MAX), &either);
    assert_eq!(env.offer(liquidated).status, StatusV2::Liquidated);
    // The unused offers are untouched.
    for o in [spare, n2, n3] {
        assert_eq!(env.offer(o).status, StatusV2::Open);
    }
}

#[test]
fn the_new_loan_must_pass_origination_at_a_fresh_price() {
    let mut env = Env::new();
    let o = env.open_loan(1, 1);
    let s = env.stranger.insecure_clone();
    let n = offer_from(&mut env, &s, 7, 90_000_000, COLLATERAL, Pubkey::default());
    env.at(START + DAY);
    // 95.4 USDC of new exposure against 1.02 wSOL at 120 (~122 USDC) is ~78%, above 70%.
    env.price_usd(120, 120);
    assert_err(env.refinance(o, n, u64::MAX), LoanV2Error::InsufficientCollateral);
    // A stale price is never used.
    env.post(150 * USD, (150 * USD / 1000) as u64, 150 * USD, (150 * USD / 1000) as u64, START);
    assert_err(env.refinance(o, n, u64::MAX), LoanV2Error::StalePrice);
    assert_eq!(env.offer(o).status, StatusV2::Active);
    env.price_usd(150, 150);
    env.refinance(o, n, u64::MAX).unwrap();
}

#[test]
fn jitosol_refinance_moves_jitosol_and_reads_its_own_feed() {
    let mut env = Env::new();
    env.configure_jito(true);
    env.jito_usd(180, 180);
    let o = open_jito_loan(&mut env, 1);
    let (jito, jp, extra) = (env.jito, env.jito_price, env.jito_extra());
    let (b, s) = (env.borrower.insecure_clone(), env.stranger.insecure_clone());
    let n = env.create_by(&s, 5, jito_terms(), Pubkey::default(), jito, extra.clone()).unwrap();
    env.at(START + DAY);
    env.jito_usd(180, 180);
    env.price_usd(150, 150);
    let sol_price = env.price;
    assert_err(env.refinance_with(o, n, &b, u64::MAX, jito, jp, vec![]), LoanV2Error::CollateralNotConfigured);
    assert_err(env.refinance_with(o, n, &b, u64::MAX, jito, sol_price, extra.clone()), LoanV2Error::InvalidFeedId);
    let b_jito0 = env.balance(ata(b.pubkey(), jito));
    env.refinance_with(o, n, &b, u64::MAX, jito, jp, extra).unwrap();
    assert_eq!(env.offer(o).status, StatusV2::Refinanced);
    let new = env.offer(n);
    assert_eq!((new.status, new.wsol_mint, new.collateral_locked), (StatusV2::Active, jito, JITO_COLLATERAL));
    assert_eq!(env.balance(pda(&[WSOL_VAULT_SEED, n.as_ref()])), JITO_COLLATERAL);
    assert_eq!(env.balance(ata(b.pubkey(), jito)), b_jito0, "jitoSOL moved vault to vault");
    env.at(START + 5 * DAY);
    let payoff = env.payoff(n);
    env.repay_to(n, payoff, s.pubkey(), jito).unwrap();
    assert_eq!(env.offer(n).status, StatusV2::Repaid);
    assert_eq!(env.balance(ata(b.pubkey(), jito)), b_jito0 + JITO_COLLATERAL, "every jitoSOL atom came back");
}
