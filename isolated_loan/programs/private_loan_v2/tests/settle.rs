//! LiteSVM tests for V2 private settlement (Story 22.2).
//!
//! `watch_loan`, `fund_quote`, `settle_ticket` and `refund_ticket` run without the ER runtime
//! once their records exist, so the ER-only `LoanTerms` and the quote record are placed
//! directly. The Pyth account is owned by the real receiver id and read through the same
//! `loan-core` checks as on Devnet. Run `anchor build` first.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountSerialize, AnchorDeserialize, AnchorSerialize, InstructionData, ToAccountMetas};
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
        for k in &liq {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        let creator = Pubkey::new_unique();
        let nonce = 7u64;
        let (anchor, anchor_bump) = pda(&[b"loan", creator.as_ref(), &nonce.to_le_bytes()]);
        let (pool, pool_bump) = pda(&[b"liq-pool"]);
        let mut env = Env {
            svm,
            lender: creator,
            borrower: Pubkey::new_unique(),
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
        let ix = Instruction {
            program_id: ID,
            accounts: private_loan_v2::accounts::WatchLoan {
                anchor: self.anchor,
                terms: self.terms,
                quote: self.quote,
                loan_wsol: ata(&self.anchor, &self.wsol),
                lender_usdc: ata(&self.lender, &self.usdc),
                borrower_wsol: ata(&self.borrower, &self.wsol),
                pool: self.pool,
                pool_usdc: ata(&self.pool, &self.usdc),
                pool_wsol: ata(&self.pool, &self.wsol),
                price_update: self.price,
                token_program: TOKEN,
            }
            .to_account_metas(None),
            data: private_loan_v2::instruction::WatchLoan {}.data(),
        };
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
