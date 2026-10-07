//! LiteSVM tests for V2 private settlement (Story 22.2), its operations (Story 26.4) and private
//! automation mandates evaluated by the rollup crank (Story 26.3).
//!
//! `watch_loan`, `fund_quote`, `settle_ticket` and `refund_ticket` run without the ER runtime
//! once their records exist, so the ER-only `LoanTerms` and the quote record are placed
//! directly. The Pyth account is owned by the real receiver id and read through the same
//! `loan-core` checks as on Devnet. Run `anchor build` first.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::{AccountDeserialize, AccountSerialize, AnchorDeserialize, AnchorSerialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address as ata;
use litesvm::LiteSVM;
use loan_core::accounting as acc;
use private_loan_v2::loan::{LedgerState, LoanAnchor, LoanTerms, STATUS_ACTIVE, STATUS_LIQUIDATED, STATUS_OVERDUE_LIQUIDATED};
use private_loan_v2::settle::{q, LiquidationPool, KIND_OVERDUE, KIND_RISK, QUOTE_OPEN, TICKET_PAID, TICKET_REFUNDED, TICKET_WON};
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
use solana_account::Account;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const ID: Pubkey = private_loan_v2::ID;
const TOKEN: Pubkey = anchor_spl::token::ID;
const DAY: i64 = 86_400;
const START: i64 = 1_700_000_000;
const PRINCIPAL: u64 = 100_000_000;
const COLLATERAL: u64 = 1_020_000_000;
const LIQ_LTV: u16 = 8_000;
const USD: i64 = 100_000_000;
const RECEIVER: Pubkey = loan_core::constants::PYTH_RECEIVER_PROGRAM_ID;

struct Env {
    svm: LiteSVM,
    lender: Pubkey,
    borrower: Pubkey,
    borrower_kp: Keypair,
    governance: Keypair,
    liq: [Keypair; 2],
    usdc: Pubkey,
    wsol: Pubkey,
    anchor: Pubkey,
    terms: Pubkey,
    quote: Pubkey,
    pool: Pubkey,
    price: Pubkey,
    now: i64,
}

fn pda(seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, &ID)
}

fn base_terms(lender: Pubkey, borrower: Pubkey) -> LoanTerms {
    let mut t = LoanTerms {
        version: 2, origin_lender: lender, current_lender: lender, borrower, room_index: 0, request_index: 0,
        principal: PRINCIPAL, interest_bps: 500, duration_seconds: 30 * DAY, early_repayment: 1, min_interest_bps: 2_500,
        grace_seconds: DAY, late_fee_bps: 100, annual_ceiling_bps: 10_000, collateral_required: COLLATERAL, collateral_locked: COLLATERAL,
        max_ltv_bps: 7_000, liquidation_ltv_bps: LIQ_LTV, revision: 1, funded_revision: 1, accepted_revision: 1, status: STATUS_ACTIVE,
        start_ts: START, ledger: LedgerState::default(), ledger_revision: 0, shortfall: 0, settled_ts: 0, desk: Pubkey::default(),
        policy_version: 0, auditor_hash: [0; 32],
    };
    t.ledger = acc::open(&t.core_terms().unwrap()).unwrap().into();
    t
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/private_loan_v2.so");
        svm.add_program_from_file(ID, so).expect("run `anchor build` first");
        let liq = [Keypair::new(), Keypair::new()];
        let (borrower_kp, governance) = (Keypair::new(), Keypair::new());
        for k in [&liq[0], &liq[1], &borrower_kp, &governance] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        let creator = Pubkey::new_unique();
        let nonce = 7u64;
        let (anchor, anchor_bump) = pda(&[b"loan", creator.as_ref(), &nonce.to_le_bytes()]);
        let (pool, pool_bump) = pda(&[b"liq-pool"]);
        let mut env = Env {
            svm,
            lender: creator,
            borrower: borrower_kp.pubkey(),
            borrower_kp,
            governance,
            liq,
            usdc: Pubkey::new_unique(),
            wsol: Pubkey::new_unique(),
            anchor,
            terms: pda(&[b"loan-terms", anchor.as_ref()]).0,
            quote: pda(&[b"quote", anchor.as_ref()]).0,
            pool,
            price: Pubkey::new_unique(),
            now: START,
        };
        env.at(START + DAY);
        env.put_mint(env.usdc, 6);
        env.put_mint(env.wsol, 9);
        let a = LoanAnchor { version: 2, creator, nonce, room: Pubkey::new_unique(), usdc_mint: env.usdc, wsol_mint: env.wsol, bump: anchor_bump };
        let mut data = Vec::new();
        a.try_serialize(&mut data).unwrap();
        env.put(anchor, ID, data);
        let p = LiquidationPool { usdc_mint: env.usdc, wsol_mint: env.wsol, bump: pool_bump };
        let mut data = Vec::new();
        p.try_serialize(&mut data).unwrap();
        env.put(pool, ID, data);
        let t = base_terms(env.lender, env.borrower);
        env.write_terms(&t);
        env.put(env.quote, ID, vec![0u8; q::LEN]);

        let (l, b) = (env.lender, env.borrower);
        env.put_ata(env.wsol, anchor, COLLATERAL);
        env.put_ata(env.usdc, l, 0);
        env.put_ata(env.wsol, b, 0);
        env.put_ata(env.usdc, b, 500_000_000);
        env.put_ata(env.usdc, anchor, 0);
        env.put_ata(env.usdc, pool, 0);
        env.put_ata(env.wsol, pool, 0);
        for k in [env.liq[0].pubkey(), env.liq[1].pubkey()] {
            env.put_ata(env.usdc, k, 500_000_000);
            env.put_ata(env.wsol, k, 0);
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

    fn write_terms(&mut self, t: &LoanTerms) {
        let mut data = Vec::new();
        t.serialize(&mut data).unwrap();
        data.resize(LoanTerms::LEN, 0);
        self.put(self.terms, ID, data);
    }

    fn terms(&self) -> LoanTerms {
        LoanTerms::deserialize(&mut &self.svm.get_account(&self.terms).unwrap().data[..]).unwrap()
    }

    fn put(&mut self, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len()).max(1);
        self.svm.set_account(key, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
    }

    fn put_mint(&mut self, mint: Pubkey, decimals: u8) {
        let mut data = vec![0u8; 82];
        data[44] = decimals;
        data[45] = 1;
        self.put(mint, TOKEN, data);
    }

    fn put_ata(&mut self, mint: Pubkey, owner: Pubkey, amount: u64) {
        let mut data = vec![0u8; 165];
        data[0..32].copy_from_slice(mint.as_ref());
        data[32..64].copy_from_slice(owner.as_ref());
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        data[108] = 1;
        self.put(ata(&owner, &mint), TOKEN, data);
    }

    fn balance(&self, owner: Pubkey, mint: Pubkey) -> u64 {
        let a = self.svm.get_account(&ata(&owner, &mint)).unwrap();
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    }

    /// Spot and EMA in whole dollars with 0.1% confidence, published now.
    fn price_usd(&mut self, spot: i64, ema: i64) {
        let update = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: VerificationLevel::Full,
            price_message: PriceFeedMessage {
                feed_id: loan_core::constants::SOL_USD_FEED_ID,
                price: spot * USD,
                conf: (spot * USD / 1000) as u64,
                exponent: -8,
                publish_time: self.now,
                prev_publish_time: self.now - 1,
                ema_price: ema * USD,
                ema_conf: (ema * USD / 1000) as u64,
            },
            posted_slot: 1,
        };
        let mut data = Vec::new();
        update.try_serialize(&mut data).unwrap();
        self.put(self.price, RECEIVER, data);
    }

    fn quote(&self) -> Vec<u8> {
        self.svm.get_account(&self.quote).unwrap().data
    }

    fn quote_revision(&self) -> u32 {
        u32::from_le_bytes(self.quote()[q::REVISION..q::REVISION + 4].try_into().unwrap())
    }

    fn ticket_state(&self, i: usize) -> u8 {
        self.quote()[q::TICKETS + i * q::T + q::T - 1]
    }

    fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), String> {
        self.svm.expire_blockhash();
        let tx = Transaction::new(&[signer], Message::new(&[ix], Some(&signer.pubkey())), self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs))
    }

    fn watch(&mut self) -> Result<(), String> {
        let lender = self.lender;
        self.watch_for(lender, vec![])
    }

    /// A crank whose fixed accounts name `lender`'s USDC account, plus any trailing accounts.
    fn watch_for(&mut self, lender: Pubkey, extra: Vec<AccountMeta>) -> Result<(), String> {
        let mut accounts = private_loan_v2::accounts::WatchLoan {
            anchor: self.anchor,
            terms: self.terms,
            quote: self.quote,
            loan_wsol: ata(&self.anchor, &self.wsol),
            lender_usdc: ata(&lender, &self.usdc),
            borrower_wsol: ata(&self.borrower, &self.wsol),
            pool: self.pool,
            pool_usdc: ata(&self.pool, &self.usdc),
            pool_wsol: ata(&self.pool, &self.wsol),
            price_update: self.price,
            token_program: TOKEN,
        }
        .to_account_metas(None);
        accounts.extend(extra);
        let ix = Instruction { program_id: ID, accounts, data: private_loan_v2::instruction::WatchLoan {}.data() };
        let payer = Keypair::new();
        self.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        self.send(ix, &payer)
    }

    fn fund(&mut self, who: usize, revision: u32) -> Result<(), String> {
        let k = self.liq[who].insecure_clone();
        let ix = Instruction {
            program_id: ID,
            accounts: private_loan_v2::accounts::FundQuote {
                liquidator: k.pubkey(),
                anchor: self.anchor,
                quote: self.quote,
                pool: self.pool,
                liquidator_usdc: ata(&k.pubkey(), &self.usdc),
                pool_usdc: ata(&self.pool, &self.usdc),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            data: private_loan_v2::instruction::FundQuote { revision }.data(),
        };
        self.send(ix, &k)
    }

    fn settle(&mut self, who: usize) -> Result<(), String> {
        let k = self.liq[who].insecure_clone();
        let ix = Instruction {
            program_id: ID,
            accounts: private_loan_v2::accounts::SettleTicket {
                liquidator: k.pubkey(),
                anchor: self.anchor,
                quote: self.quote,
                pool: self.pool,
                liquidator_usdc: ata(&k.pubkey(), &self.usdc),
                liquidator_wsol: ata(&k.pubkey(), &self.wsol),
                pool_usdc: ata(&self.pool, &self.usdc),
                pool_wsol: ata(&self.pool, &self.wsol),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            data: private_loan_v2::instruction::SettleTicket {}.data(),
        };
        self.send(ix, &k)
    }

    fn payoff(&self) -> u64 {
        self.terms().payoff(self.now).unwrap()
    }
}

#[test]
fn a_healthy_loan_gets_no_quote() {
    let mut env = Env::new();
    env.watch().unwrap();
    assert!(env.quote().iter().all(|b| *b == 0));
}

#[test]
fn wick_protection_needs_the_average_too_unless_the_spot_is_far_past() {
    let mut env = Env::new();
    env.price_usd(120, 150);
    env.watch().unwrap();
    assert!(env.quote().iter().all(|b| *b == 0), "spot past the line, average healthy: no quote");
    env.price_usd(119, 150);
    env.watch().unwrap();
    let d = env.quote();
    assert_eq!((d[q::VERSION], d[q::STATE], d[q::KIND]), (2, QUOTE_OPEN, KIND_RISK));
}

#[test]
fn risk_liquidation_pays_the_exact_payoff_and_returns_the_excess_once() {
    let mut env = Env::new();
    env.price_usd(120, 120);
    env.watch().unwrap();
    let rev = env.quote_revision();
    let quoted = u64::from_le_bytes(env.quote()[q::DEBT..q::DEBT + 8].try_into().unwrap());
    env.fund(0, rev).unwrap();
    // Thirty seconds later the payoff has grown, but less than the quote allowed for.
    env.at(env.now + 30);
    env.price_usd(120, 120);
    let payoff = env.payoff();
    assert!(payoff <= quoted);
    let (l0, b0) = (env.balance(env.lender, env.usdc), env.balance(env.borrower, env.wsol));
    env.watch().unwrap();
    assert_eq!(env.terms().status, STATUS_LIQUIDATED);
    assert_eq!(env.balance(env.lender, env.usdc) - l0, payoff, "the lender gets the exact payoff");
    assert!(env.balance(env.borrower, env.wsol) > b0, "the surplus returns to the borrower");
    assert_eq!(env.ticket_state(0), TICKET_WON);
    let liq = env.liq[0].pubkey();
    let usdc0 = env.balance(liq, env.usdc);
    env.settle(0).unwrap();
    assert_eq!(env.balance(liq, env.usdc) - usdc0, quoted - payoff, "excess funding comes back");
    assert!(env.balance(liq, env.wsol) > 0);
    assert_eq!(env.ticket_state(0), TICKET_PAID);
    assert!(env.settle(0).is_err(), "and only once");
}

#[test]
fn after_grace_the_quote_opens_regardless_of_ltv() {
    let mut env = Env::new();
    let t = env.terms().core_terms().unwrap();
    env.at(t.grace_end() - 1);
    env.price_usd(150, 150);
    env.watch().unwrap();
    assert!(env.quote().iter().all(|b| *b == 0), "in grace a healthy loan gets no quote");
    env.at(t.grace_end());
    env.price_usd(150, 150);
    env.watch().unwrap();
    assert_eq!(env.quote()[q::KIND], KIND_OVERDUE);
    let rev = env.quote_revision();
    env.fund(0, rev).unwrap();
    let b0 = env.balance(env.borrower, env.wsol);
    env.watch().unwrap();
    let after = env.terms();
    assert_eq!(after.status, STATUS_OVERDUE_LIQUIDATED);
    assert_eq!(after.collateral_locked, 0);
    assert!(env.balance(env.borrower, env.wsol) - b0 > COLLATERAL / 4, "a healthy loan's surplus returns");
}

#[test]
fn a_payment_after_quoting_makes_the_quote_stale_and_the_ticket_refundable() {
    let mut env = Env::new();
    env.price_usd(120, 120);
    env.watch().unwrap();
    let rev = env.quote_revision();
    let paid_in = u64::from_le_bytes(env.quote()[q::DEBT..q::DEBT + 8].try_into().unwrap());
    env.fund(0, rev).unwrap();
    let liq = env.liq[0].pubkey();
    let funded = env.balance(liq, env.usdc);
    // The borrower pays part of the loan: the ledger revision moves.
    let mut t = env.terms();
    t.ledger_revision += 1;
    env.write_terms(&t);
    env.watch().unwrap();
    assert_eq!(env.quote_revision(), rev + 1, "a new revision, nothing executed");
    assert_eq!(env.terms().status, STATUS_ACTIVE);
    env.settle(0).unwrap();
    assert_eq!(env.ticket_state(0), TICKET_REFUNDED);
    assert_eq!(env.balance(liq, env.usdc) - funded, paid_in, "refunded in full");
    assert!(env.settle(0).is_err(), "refunded once");
}

#[test]
fn the_losing_ticket_is_refunded_in_full() {
    let mut env = Env::new();
    env.price_usd(120, 120);
    env.watch().unwrap();
    let rev = env.quote_revision();
    let quoted = u64::from_le_bytes(env.quote()[q::DEBT..q::DEBT + 8].try_into().unwrap());
    env.fund(0, rev).unwrap();
    env.fund(1, rev).unwrap();
    env.watch().unwrap();
    assert_eq!((env.ticket_state(0), env.ticket_state(1)), (TICKET_WON, 0));
    let loser = env.liq[1].pubkey();
    let before = env.balance(loser, env.usdc);
    env.settle(1).unwrap();
    assert_eq!(env.balance(loser, env.usdc) - before, quoted);
    assert_eq!(env.ticket_state(1), TICKET_REFUNDED);
}

#[test]
fn a_recovered_price_withdraws_the_open_quote() {
    let mut env = Env::new();
    env.price_usd(120, 120);
    env.watch().unwrap();
    env.price_usd(150, 150);
    env.watch().unwrap();
    assert_eq!(env.quote()[q::STATE], private_loan_v2::settle::QUOTE_WITHDRAWN);
}

// ---- Story 26.4: a quote racing repayment, rebinding, and governed quote parameters ---------

use private_loan_v2::config::Config;
use private_loan_v2::error::PrivateLoanError;
use private_loan_v2::loan::STATUS_REPAID;
use private_loan_v2::mandate::PrivateMandate;
use private_loan_v2::settle::{QuoteParams, QUOTE_TTL_SECONDS, QUOTE_WITHDRAWN};

fn code(e: PrivateLoanError) -> String {
    format!("Custom({})", u32::from(e))
}

fn assert_err(r: Result<(), String>, e: PrivateLoanError) {
    let msg = r.expect_err("expected the instruction to fail");
    assert!(msg.contains(&code(e)), "expected {e:?} ({}), got {msg}", code(e));
}

impl Env {
    /// The borrower's own `repay`, signed, as in the rollup.
    fn repay(&mut self, amount: u64) -> Result<(), String> {
        let b = self.borrower_kp.insecure_clone();
        let t = self.terms();
        let ix = Instruction {
            program_id: ID,
            accounts: private_loan_v2::accounts::BorrowerMoves {
                borrower: b.pubkey(),
                anchor: self.anchor,
                terms: self.terms,
                borrower_usdc: ata(&b.pubkey(), &self.usdc),
                borrower_wsol: ata(&b.pubkey(), &self.wsol),
                loan_usdc: ata(&self.anchor, &self.usdc),
                loan_wsol: ata(&self.anchor, &self.wsol),
                lender_usdc: ata(&t.current_lender, &self.usdc),
                price_update: self.price,
                token_program: TOKEN,
                deal: None,
                deal_permission: None,
                vault: None,
                magic_program: None,
                permission_program: None,
                terms_permission: None,
                desk_policy: None,
            }
            .to_account_metas(None),
            data: private_loan_v2::instruction::Repay { amount }.data(),
        };
        self.send(ix, &b)
    }

    fn params_pda() -> Pubkey {
        pda(&[b"quote-params"]).0
    }

    fn put_config(&mut self) -> Keypair {
        let pool_admin = Keypair::new();
        self.svm.airdrop(&pool_admin.pubkey(), 1_000_000_000).unwrap();
        let (config, bump) = pda(&[b"config"]);
        let authorities = governance::Authorities {
            governance: self.governance.pubkey(),
            ai_admin: Pubkey::new_unique(),
            ai_worker: Pubkey::new_unique(),
            liquidation_pool_admin: pool_admin.pubkey(),
            credential_issuer: Pubkey::new_unique(),
            keeper: Pubkey::new_unique(),
        };
        let mut data = Vec::new();
        Config { version: 1, authorities, bump }.try_serialize(&mut data).unwrap();
        self.put(config, ID, data);
        pool_admin
    }

    fn set_quote_params(&mut self, signer: &Keypair, ttl: i64) -> Result<(), String> {
        let ix = Instruction {
            program_id: ID,
            accounts: private_loan_v2::accounts::SetQuoteParams {
                governance: signer.pubkey(),
                config: pda(&[b"config"]).0,
                params: Self::params_pda(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: private_loan_v2::instruction::SetQuoteParams { quote_ttl_seconds: ttl }.data(),
        };
        self.send(ix, signer)
    }

    fn quote_expires(&self) -> i64 {
        i64::from_le_bytes(self.quote()[q::EXPIRES..q::EXPIRES + 8].try_into().unwrap())
    }
}

#[test]
fn a_repayment_racing_an_open_quote_wins_and_the_ticket_refunds_at_once() {
    let mut env = Env::new();
    env.price_usd(120, 120);
    env.watch().unwrap();
    let rev = env.quote_revision();
    let paid_in = u64::from_le_bytes(env.quote()[q::DEBT..q::DEBT + 8].try_into().unwrap());
    env.fund(0, rev).unwrap();
    let liq = env.liq[0].pubkey();
    let funded = env.balance(liq, env.usdc);
    // The borrower repays in full before the next watch run.
    let (payoff, l0) = (env.payoff(), env.balance(env.lender, env.usdc));
    env.repay(u64::MAX).unwrap();
    assert_eq!(env.terms().status, STATUS_REPAID);
    assert_eq!(env.balance(env.lender, env.usdc) - l0, payoff, "the lender is paid once, by the borrower");
    assert_eq!(env.balance(env.borrower, env.wsol), COLLATERAL);
    // The next run withdraws the quote instead of executing it.
    env.watch().unwrap();
    assert_eq!(env.quote()[q::STATE], QUOTE_WITHDRAWN);
    assert_eq!(env.balance(env.lender, env.usdc) - l0, payoff);
    // The quote has not expired, but the ticket is refundable now.
    env.settle(0).unwrap();
    assert_eq!(env.ticket_state(0), TICKET_REFUNDED);
    assert_eq!(env.balance(liq, env.usdc) - funded, paid_in);
}

#[test]
fn a_quote_executing_first_makes_the_late_repayment_fail() {
    let mut env = Env::new();
    env.price_usd(120, 120);
    env.watch().unwrap();
    let rev = env.quote_revision();
    env.fund(0, rev).unwrap();
    env.watch().unwrap();
    assert_eq!(env.terms().status, STATUS_LIQUIDATED);
    let l0 = env.balance(env.lender, env.usdc);
    assert_err(env.repay(u64::MAX), PrivateLoanError::WrongStatus);
    assert_eq!(env.balance(env.lender, env.usdc), l0, "the lender is never paid twice");
}

#[test]
fn after_a_transfer_only_the_rebound_watch_decides_and_pays_the_new_lender() {
    let mut env = Env::new();
    let (old, new) = (env.lender, Pubkey::new_unique());
    env.put_ata(env.usdc, new, 0);
    // The position changes hands (a later sale): only `current_lender` moves.
    let mut t = env.terms();
    t.current_lender = new;
    env.write_terms(&t);
    env.price_usd(120, 120);
    // The original crank names the old lender's account: no decision, no quote.
    env.watch_for(old, vec![]).unwrap();
    assert!(env.quote().iter().all(|b| *b == 0));
    // The rebound crank quotes and executes, paying the new lender.
    env.watch_for(new, vec![]).unwrap();
    let rev = env.quote_revision();
    env.fund(0, rev).unwrap();
    let payoff = env.payoff();
    env.watch_for(old, vec![]).unwrap();
    assert_eq!(env.terms().status, STATUS_ACTIVE, "the stale crank still does nothing");
    env.watch_for(new, vec![]).unwrap();
    assert_eq!(env.terms().status, STATUS_LIQUIDATED);
    assert_eq!(env.balance(new, env.usdc), payoff);
    assert_eq!(env.balance(old, env.usdc), 0);
}

#[test]
fn only_governance_sets_the_quote_ttl_and_the_watch_uses_it() {
    let mut env = Env::new();
    let pool_admin = env.put_config();
    let g = env.governance.insecure_clone();
    assert_err(env.set_quote_params(&pool_admin, 300), PrivateLoanError::WrongAuthority);
    assert_err(env.set_quote_params(&g, 29), PrivateLoanError::InvalidQuoteParams);
    assert_err(env.set_quote_params(&g, 601), PrivateLoanError::InvalidQuoteParams);
    let params = Env::params_pda();
    // Not written yet: the default applies.
    env.price_usd(120, 120);
    env.watch_for(env.lender, vec![AccountMeta::new_readonly(params, false)]).unwrap();
    assert_eq!(env.quote_expires(), env.now + QUOTE_TTL_SECONDS);
    env.set_quote_params(&g, 300).unwrap();
    let p = QuoteParams::try_deserialize(&mut &env.svm.get_account(&params).unwrap().data[..]).unwrap();
    assert_eq!(p.quote_ttl_seconds, 300);
    // A new revision uses the rotated TTL; a crank without the account keeps the default.
    let mut t = env.terms();
    t.ledger_revision += 1;
    env.write_terms(&t);
    env.watch_for(env.lender, vec![AccountMeta::new_readonly(params, false)]).unwrap();
    assert_eq!(env.quote_expires(), env.now + 300);
    // Any other trailing account is refused.
    let lender = env.lender;
    let r = env.watch_for(lender, vec![AccountMeta::new_readonly(Pubkey::new_unique(), false)]);
    assert_err(r, PrivateLoanError::InvalidRecord);
}

// ---- Story 26.3: private mandates, evaluated by the rollup crank -----------------------------

const SOL: u64 = 1_000_000_000;

fn private_mandate(borrower: Pubkey, source: Pubkey, destination: Pubkey, action: u8, trigger: u8, bump: u8) -> PrivateMandate {
    PrivateMandate {
        version: 1,
        borrower,
        action,
        source,
        destination,
        trigger,
        trigger_ltv_bps: if trigger == 0 { 7_500 } else { 0 },
        lead_seconds: if trigger == 1 { DAY } else { 0 },
        amount_per_exec: if action == 0 { SOL / 10 } else { 500_000_000 },
        cumulative_cap: if action == 0 { SOL / 4 } else { 500_000_000 },
        used: 0,
        expiry: START + 60 * DAY,
        armed: true,
        revoked: false,
        executions: 0,
        last_exec_ts: 0,
        bump,
    }
}

impl Env {
    fn mandate_pda(&self, action: u8) -> (Pubkey, u8) {
        pda(&[b"mandate", self.anchor.as_ref(), &[action]])
    }

    fn put_mandate(&mut self, md: &PrivateMandate) {
        let mut data = Vec::new();
        md.serialize(&mut data).unwrap();
        let key = self.mandate_pda(md.action).0;
        self.put(key, ID, data);
    }

    fn read_mandate(&self, action: u8) -> PrivateMandate {
        PrivateMandate::deserialize(&mut &self.svm.get_account(&self.mandate_pda(action).0).unwrap().data[..]).unwrap()
    }

    /// The borrower's ATA with `amount`, delegating `allowance` to `delegate`.
    fn put_delegated(&mut self, mint: Pubkey, amount: u64, delegate: Pubkey, allowance: u64) {
        let owner = self.borrower;
        self.put_ata(mint, owner, amount);
        let key = ata(&owner, &mint);
        let mut acc = self.svm.get_account(&key).unwrap();
        acc.data[72..76].copy_from_slice(&1u32.to_le_bytes());
        acc.data[76..108].copy_from_slice(delegate.as_ref());
        acc.data[121..129].copy_from_slice(&allowance.to_le_bytes());
        self.svm.set_account(key, acc).unwrap();
    }

    /// A health top-up: 0.1 wSOL per execution, 0.25 in all, at 75%.
    fn arm_top_up(&mut self) -> Pubkey {
        let (key, bump) = self.mandate_pda(0);
        let (src, dst) = (ata(&self.borrower, &self.wsol), ata(&self.anchor, &self.wsol));
        let md = private_mandate(self.borrower, src, dst, 0, 0, bump);
        self.put_mandate(&md);
        self.put_delegated(self.wsol, 2 * SOL, key, SOL / 4);
        key
    }

    /// A time repay of up to 500 USDC, a day before maturity.
    fn arm_repay(&mut self) -> Pubkey {
        let (key, bump) = self.mandate_pda(1);
        let (src, dst) = (ata(&self.borrower, &self.usdc), ata(&self.lender, &self.usdc));
        let md = private_mandate(self.borrower, src, dst, 1, 1, bump);
        self.put_mandate(&md);
        self.put_delegated(self.usdc, 500_000_000, key, 500_000_000);
        key
    }

    fn run_mandate(&mut self, action: u8) -> Result<(), String> {
        let md = self.read_mandate(action);
        let repay = action == 1;
        let ix = Instruction {
            program_id: ID,
            accounts: private_loan_v2::accounts::RunMandate {
                anchor: self.anchor,
                terms: self.terms,
                mandate: self.mandate_pda(action).0,
                source: md.source,
                destination: md.destination,
                loan_wsol: repay.then(|| ata(&self.anchor, &self.wsol)),
                borrower_wsol: repay.then(|| ata(&self.borrower, &self.wsol)),
                price_update: self.price,
                token_program: TOKEN,
            }
            .to_account_metas(None),
            data: private_loan_v2::instruction::RunMandate {}.data(),
        };
        let payer = Keypair::new();
        self.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        self.send(ix, &payer)
    }

    fn revoke_private(&mut self, action: u8) -> Result<(), String> {
        let b = self.borrower_kp.insecure_clone();
        let md = self.read_mandate(action);
        let ix = Instruction {
            program_id: ID,
            accounts: private_loan_v2::accounts::RevokePrivateMandate { borrower: b.pubkey(), anchor: self.anchor, mandate: self.mandate_pda(action).0, source: md.source, token_program: TOKEN }
                .to_account_metas(None),
            data: private_loan_v2::instruction::RevokePrivateMandate {}.data(),
        };
        self.send(ix, &b)
    }
}

#[test]
fn the_rollup_crank_tops_up_on_health_and_rearms_itself_after_the_gap() {
    let mut env = Env::new();
    env.arm_top_up();
    let vault = ata(&env.anchor, &env.wsol);
    // ~66% at 150: nothing.
    env.run_mandate(0).unwrap();
    assert_eq!(env.terms().collateral_locked, COLLATERAL);
    // ~79.6% at 125: one top-up, and an open quote revision would go stale.
    env.price_usd(125, 125);
    let rev0 = env.terms().ledger_revision;
    env.run_mandate(0).unwrap();
    assert_eq!(env.balance(env.anchor, env.wsol), COLLATERAL + SOL / 10);
    assert_eq!(env.svm.get_account(&vault).is_some(), true);
    let t = env.terms();
    assert_eq!((t.collateral_locked, t.ledger_revision), (COLLATERAL + SOL / 10, rev0 + 1));
    let md = env.read_mandate(0);
    assert_eq!((md.armed, md.used, md.executions), (false, SOL / 10, 1));
    // Still past the trigger: no second top-up until re-armed.
    env.price_usd(115, 115);
    env.run_mandate(0).unwrap();
    assert_eq!(env.terms().collateral_locked, COLLATERAL + SOL / 10);
    // Back below 73%: the crank re-arms (and moves nothing that run).
    env.price_usd(150, 150);
    env.run_mandate(0).unwrap();
    assert!(env.read_mandate(0).armed);
    assert_eq!(env.terms().collateral_locked, COLLATERAL + SOL / 10);
    env.price_usd(115, 115);
    env.run_mandate(0).unwrap();
    // The 0.25 cap leaves 0.05 for the third: it clamps.
    env.price_usd(150, 150);
    env.run_mandate(0).unwrap();
    env.price_usd(100, 100);
    env.run_mandate(0).unwrap();
    let md = env.read_mandate(0);
    assert_eq!((md.used, md.executions), (SOL / 4, 3));
    assert_eq!(env.terms().collateral_locked, COLLATERAL + SOL / 4);
}

#[test]
fn the_rollup_crank_repays_clamped_to_the_payoff_and_closes_the_loan() {
    let mut env = Env::new();
    env.arm_repay();
    let t = env.terms().core_terms().unwrap();
    env.at(t.maturity() - DAY - 1);
    env.price_usd(150, 150);
    env.run_mandate(1).unwrap();
    assert_eq!(env.terms().status, STATUS_ACTIVE, "not due yet");
    env.at(t.maturity() - DAY);
    let (payoff, l0) = (env.payoff(), env.balance(env.lender, env.usdc));
    env.run_mandate(1).unwrap();
    assert_eq!(env.balance(env.lender, env.usdc) - l0, payoff, "exactly the payoff");
    assert_eq!(env.terms().status, STATUS_REPAID);
    assert_eq!(env.balance(env.borrower, env.wsol), COLLATERAL, "all collateral returns");
    assert_eq!(env.read_mandate(1).used, payoff);
    // After settlement nothing moves.
    env.run_mandate(1).unwrap();
    assert_eq!(env.balance(env.lender, env.usdc) - l0, payoff);
}

#[test]
fn private_mandates_do_nothing_when_revoked_expired_settled_undelegated_or_resold() {
    // Revoked by the borrower: the record stops and the delegate is cleared.
    let mut env = Env::new();
    env.arm_top_up();
    env.revoke_private(0).unwrap();
    assert!(env.read_mandate(0).revoked);
    assert_eq!(env.svm.get_account(&ata(&env.borrower, &env.wsol)).unwrap().data[72], 0, "delegate revoked");
    env.price_usd(100, 100);
    env.run_mandate(0).unwrap();
    assert_eq!(env.terms().collateral_locked, COLLATERAL);

    // Delegate revoked outside ZenLo.
    let mut env = Env::new();
    let key = env.arm_top_up();
    env.put_delegated(env.wsol, 2 * SOL, key, 0);
    env.price_usd(100, 100);
    env.run_mandate(0).unwrap();
    assert_eq!(env.terms().collateral_locked, COLLATERAL);

    // Expired.
    let mut env = Env::new();
    env.arm_top_up();
    env.at(START + 60 * DAY);
    env.price_usd(100, 100);
    env.run_mandate(0).unwrap();
    assert_eq!(env.terms().collateral_locked, COLLATERAL);

    // Settled by a liquidation first.
    let mut env = Env::new();
    env.arm_top_up();
    env.price_usd(100, 100);
    env.watch().unwrap();
    let rev = env.quote_revision();
    env.fund(0, rev).unwrap();
    env.watch().unwrap();
    assert_eq!(env.terms().status, STATUS_LIQUIDATED);
    let before = env.balance(env.borrower, env.wsol);
    env.run_mandate(0).unwrap();
    assert_eq!(env.balance(env.borrower, env.wsol), before);

    // A repay mandate bound to the lender at creation does nothing after a sale.
    let mut env = Env::new();
    env.arm_repay();
    let mut t = env.terms();
    t.current_lender = Pubkey::new_unique();
    env.write_terms(&t);
    env.at(t.core_terms().unwrap().maturity() - DAY);
    env.price_usd(150, 150);
    let b0 = env.balance(env.borrower, env.usdc);
    env.run_mandate(1).unwrap();
    assert_eq!(env.balance(env.borrower, env.usdc), b0);
    assert_eq!(env.terms().status, STATUS_ACTIVE);
}

#[test]
fn only_the_borrower_revokes_a_private_mandate() {
    let mut env = Env::new();
    env.arm_top_up();
    let s = env.liq[0].insecure_clone();
    let md = env.read_mandate(0);
    let ix = Instruction {
        program_id: ID,
        accounts: private_loan_v2::accounts::RevokePrivateMandate { borrower: s.pubkey(), anchor: env.anchor, mandate: env.mandate_pda(0).0, source: md.source, token_program: TOKEN }
            .to_account_metas(None),
        data: private_loan_v2::instruction::RevokePrivateMandate {}.data(),
    };
    assert_err(env.send(ix, &s), PrivateLoanError::NotBorrower);
    assert!(!env.read_mandate(0).revoked);
}
