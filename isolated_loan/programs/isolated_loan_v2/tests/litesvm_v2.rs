//! V2 instruction tests on LiteSVM (Stories 21.1, 21.2). Run `anchor build` first.
//! Every boundary is driven by setting the clock to the exact second. The Pyth account is owned by
//! the real receiver program, so the owner check is exercised, never bypassed.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use isolated_loan_v2::error::LoanV2Error;
use isolated_loan_v2::state::{OfferV2, RequestStatusV2, RequestV2, StatusV2, TermsArgs};
use isolated_loan_v2::{OFFER_SEED, REQUEST_SEED, REQUEST_WSOL_VAULT_SEED, USDC_VAULT_SEED, WSOL_VAULT_SEED};
use litesvm::LiteSVM;
use loan_core::accounting as acc;
use loan_core::constants::{PYTH_RECEIVER_PROGRAM_ID, SOL_USD_FEED_ID, USDC_MINT, WSOL_MINT};
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
    now: i64,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/isolated_loan_v2.so");
        svm.add_program_from_file(ID, so).expect("run `anchor build` before the LiteSVM tests");
        let (lender, borrower, stranger) = (Keypair::new(), Keypair::new(), Keypair::new());
        for k in [&lender, &borrower, &stranger] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        let mut env = Env { svm, lender, borrower, stranger, price: Pubkey::new_unique(), now: START };
        env.at(START);
        env.put_mint(USDC_MINT, 6);
        env.put_mint(WSOL_MINT, 9);
        for k in [env.lender.pubkey(), env.borrower.pubkey(), env.stranger.pubkey()] {
            env.put_ata(USDC_MINT, k, 1_000_000_000);
            env.put_ata(WSOL_MINT, k, 10_000_000_000);
        }
        env.price_usd(150, 150);
        env
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
        let update = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: VerificationLevel::Full,
            price_message: PriceFeedMessage {
                feed_id: SOL_USD_FEED_ID,
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
        self.put(self.price, PYTH_RECEIVER_PROGRAM_ID, data);
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
        let lender = self.lender.insecure_clone();
        let offer = offer_pda(lender.pubkey(), id);
        let ix = Instruction {
            program_id: ID,
            accounts: isolated_loan_v2::accounts::CreateOffer {
                lender: lender.pubkey(),
                offer,
                usdc_mint: USDC_MINT,
                wsol_mint: WSOL_MINT,
                usdc_vault: pda(&[USDC_VAULT_SEED, offer.as_ref()]),
                lender_usdc: ata(lender.pubkey(), USDC_MINT),
                token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan_v2::instruction::CreateOffer { offer_id: id, args: a, restricted_borrower: restricted }.data(),
        };
        self.send(ix, &lender).map(|_| offer)
    }

    fn accept_as(&mut self, offer: Pubkey, b: &Keypair) -> Result<(), String> {
        let ix = Instruction {
            program_id: ID,
            accounts: isolated_loan_v2::accounts::AcceptOffer {
                borrower: b.pubkey(),
                offer,
                lender: self.lender.pubkey(),
                price_update: self.price,
                usdc_vault: pda(&[USDC_VAULT_SEED, offer.as_ref()]),
                wsol_mint: WSOL_MINT,
                wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
                borrower_usdc: ata(b.pubkey(), USDC_MINT),
                borrower_wsol: ata(b.pubkey(), WSOL_MINT),
                token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan_v2::instruction::AcceptOffer {}.data(),
        };
        self.send(ix, b)
    }

    fn open_loan(&mut self, id: u64, policy: u8) -> Pubkey {
        let o = self.create(id, args(policy), Pubkey::default()).unwrap();
        let b = self.borrower.insecure_clone();
        self.accept_as(o, &b).unwrap();
        o
    }

    fn repay(&mut self, offer: Pubkey, amount: u64) -> Result<(), String> {
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
                borrower_wsol: ata(b.pubkey(), WSOL_MINT),
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

    fn liquidation_accounts(&self, offer: Pubkey, caller: &Keypair) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
        isolated_loan_v2::accounts::Liquidate {
            caller: caller.pubkey(),
            offer,
            price_update: self.price,
            wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
            caller_usdc: ata(caller.pubkey(), USDC_MINT),
            caller_wsol: ata(caller.pubkey(), WSOL_MINT),
            lender: self.lender.pubkey(),
            lender_usdc: ata(self.lender.pubkey(), USDC_MINT),
            borrower: self.borrower.pubkey(),
            borrower_wsol: ata(self.borrower.pubkey(), WSOL_MINT),
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None)
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
        let accounts = isolated_loan_v2::accounts::LenderClaim {
            lender: signer.pubkey(),
            offer,
            price_update: price,
            wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
            lender_wsol: ata(signer.pubkey(), WSOL_MINT),
            borrower: self.borrower.pubkey(),
            borrower_wsol: ata(self.borrower.pubkey(), WSOL_MINT),
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None);
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
