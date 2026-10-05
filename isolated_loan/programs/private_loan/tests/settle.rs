//! LiteSVM tests for private liquidation and expiry (story 12.1).
//!
//! `watch_loan`, `fund_quote`, and `settle_ticket` run without the ER runtime
//! once their records exist, so the ER-only `LoanTerms` and the quote record
//! are placed directly. The Pyth account is owned by the real receiver id and
//! read through the same `loan-core` checks as on Devnet. Run `anchor build` first.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountSerialize, AnchorSerialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address as ata;
use litesvm::LiteSVM;
use private_loan::loan::{LoanAnchor, LoanTerms, STATUS_ACTIVE, STATUS_EXPIRED};
use private_loan::settle::{q, LiquidationPool, STATUS_LIQUIDATED};
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
use solana_account::Account;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const TOKEN: Pubkey = anchor_spl::token::ID;
const START: i64 = 1_700_000_000;
const PRINCIPAL: u64 = 100_000_000;
const DEBT: u64 = 105_000_000;
const COLLATERAL: u64 = 1_001_001_002;
const SEIZE: u64 = 110_250_000;
const LIQ_LTV: u16 = 8_000;
const RECEIVER: Pubkey = loan_core::constants::PYTH_RECEIVER_PROGRAM_ID;
const MAGIC: Pubkey = ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
const VAULT: Pubkey = ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;

struct Env {
    svm: LiteSVM,
    lender: Pubkey,
    borrower: Pubkey,
    liquidator: Keypair,
    liquidator2: Keypair,
    usdc: Pubkey,
    wsol: Pubkey,
    anchor: Pubkey,
    terms: Pubkey,
    quote: Pubkey,
    pool: Pubkey,
    price: Pubkey,
}

fn pda(seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, &private_loan::ID)
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/private_loan.so");
        svm.add_program_from_file(private_loan::ID, so).expect("run `anchor build` first");
        let liquidator = Keypair::new();
        let liquidator2 = Keypair::new();
        for k in [&liquidator, &liquidator2] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        let loan_id = [7u8; 32];
        let (anchor, anchor_bump) = pda(&[b"loan", &loan_id]);
        let (pool, pool_bump) = pda(&[b"liq-pool"]);
        let mut env = Env {
            svm,
            lender: Pubkey::new_unique(),
            borrower: Pubkey::new_unique(),
            liquidator,
            liquidator2,
            usdc: Pubkey::new_unique(),
            wsol: Pubkey::new_unique(),
            anchor,
            terms: pda(&[b"loan-terms", anchor.as_ref()]).0,
            quote: pda(&[b"quote", anchor.as_ref()]).0,
            pool,
            price: Pubkey::new_unique(),
        };
        env.set_time(START + 60);
        env.put_mint(env.usdc, 6);
        env.put_mint(env.wsol, 9);

        let a = LoanAnchor { loan_id, room: Pubkey::new_unique(), usdc_mint: env.usdc, wsol_mint: env.wsol, bump: anchor_bump };
        let mut data = Vec::new();
        a.try_serialize(&mut data).unwrap();
        env.put(anchor, private_loan::ID, data);
        let p = LiquidationPool { usdc_mint: env.usdc, wsol_mint: env.wsol, bump: pool_bump };
        let mut data = Vec::new();
        p.try_serialize(&mut data).unwrap();
        env.put(pool, private_loan::ID, data);

        env.put_terms(STATUS_ACTIVE, START + 7 * 86_400);
        env.put(env.quote, private_loan::ID, vec![0u8; q::LEN]);
        env.put(VAULT, anchor_lang::system_program::ID, vec![]);
        // `watch_loan` names the magic program; these paths never call it (the quote exists),
        // so any executable stands in at its address.
        env.svm.add_program_from_file(MAGIC, so).unwrap();

        let (l, b, x, y) = (env.lender, env.borrower, env.liquidator.pubkey(), env.liquidator2.pubkey());
        env.put_ata(env.wsol, anchor, COLLATERAL);
        env.put_ata(env.usdc, l, 0);
        env.put_ata(env.wsol, l, 0);
        env.put_ata(env.wsol, b, 0);
        env.put_ata(env.usdc, pool, 0);
        env.put_ata(env.wsol, pool, 0);
        for k in [x, y] {
            env.put_ata(env.usdc, k, 500_000_000);
            env.put_ata(env.wsol, k, 0);
        }
        env.post_price(15_000_000_000, 15_000_000, START + 60);
        env
    }

    fn put_terms(&mut self, status: u8, expiry: i64) {
        let t = LoanTerms {
            version: 1,
            lender: self.lender,
            borrower: self.borrower,
            principal: PRINCIPAL,
            interest_bps: 500,
            duration_seconds: 7 * 86_400,
            collateral_amount: COLLATERAL,
            max_ltv_bps: 7_000,
            liquidation_ltv_bps: LIQ_LTV,
            revision: 1,
            funded_revision: 1,
            accepted_revision: 1,
            status,
            start_ts: START,
            expiry_ts: expiry,
        };
        let mut data = Vec::new();
        t.serialize(&mut data).unwrap();
        data.resize(LoanTerms::LEN, 0);
        self.put(self.terms, private_loan::ID, data);
    }

    fn set_time(&mut self, ts: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = ts;
        self.svm.set_sysvar(&clock);
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

    fn post_price(&mut self, price: i64, conf: u64, publish_time: i64) {
        let update = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: VerificationLevel::Full,
            price_message: PriceFeedMessage {
                feed_id: loan_core::constants::SOL_USD_FEED_ID,
                price,
                conf,
                exponent: -8,
                publish_time,
                prev_publish_time: publish_time - 1,
                ema_price: price,
                ema_conf: conf,
            },
            posted_slot: 1,
        };
        let mut data = Vec::new();
        update.try_serialize(&mut data).unwrap();
        self.put(self.price, RECEIVER, data);
    }

    fn status(&self) -> u8 {
        self.svm.get_account(&self.terms).unwrap().data[LoanTerms::LEN - 17]
    }

    fn quote(&self) -> Vec<u8> {
        self.svm.get_account(&self.quote).unwrap().data
    }

    fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), String> {
        self.svm.expire_blockhash();
        let msg = Message::new(&[ix], Some(&signer.pubkey()));
        let tx = Transaction::new(&[signer], msg, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
    }

    fn watch(&mut self) -> Result<(), String> {
        let ix = Instruction {
            program_id: private_loan::ID,
            accounts: private_loan::accounts::WatchLoan {
                anchor: self.anchor,
                terms: self.terms,
                quote: self.quote,
                loan_wsol: ata(&self.anchor, &self.wsol),
                lender_usdc: ata(&self.lender, &self.usdc),
                lender_wsol: ata(&self.lender, &self.wsol),
                borrower_wsol: ata(&self.borrower, &self.wsol),
                pool: self.pool,
                pool_usdc: ata(&self.pool, &self.usdc),
                pool_wsol: ata(&self.pool, &self.wsol),
                price_update: self.price,
                vault: VAULT,
                magic_program: MAGIC,
                token_program: TOKEN,
            }
            .to_account_metas(None),
            data: private_loan::instruction::WatchLoan {}.data(),
        };
        // Signer-free instruction; any fee payer will do.
        let payer = Keypair::new();
        self.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        self.send(ix, &payer)
    }

    fn fund(&mut self, who: usize, revision: u32) -> Result<(), String> {
        let k = if who == 1 { self.liquidator.insecure_clone() } else { self.liquidator2.insecure_clone() };
        let ix = Instruction {
            program_id: private_loan::ID,
            accounts: private_loan::accounts::FundQuote {
                liquidator: k.pubkey(),
                quote: self.quote,
                pool: self.pool,
                liquidator_usdc: ata(&k.pubkey(), &self.usdc),
                pool_usdc: ata(&self.pool, &self.usdc),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            data: private_loan::instruction::FundQuote { revision }.data(),
        };
        self.send(ix, &k)
    }

    fn settle(&mut self, who: usize) -> Result<(), String> {
        let k = if who == 1 { self.liquidator.insecure_clone() } else { self.liquidator2.insecure_clone() };
        let ix = Instruction {
            program_id: private_loan::ID,
            accounts: private_loan::accounts::SettleTicket {
                liquidator: k.pubkey(),
                quote: self.quote,
                pool: self.pool,
                liquidator_usdc: ata(&k.pubkey(), &self.usdc),
                liquidator_wsol: ata(&k.pubkey(), &self.wsol),
                pool_usdc: ata(&self.pool, &self.usdc),
                pool_wsol: ata(&self.pool, &self.wsol),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            data: private_loan::instruction::SettleTicket {}.data(),
        };
        self.send(ix, &k)
    }
}

fn rd_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

/// $131.00 with no confidence: 1_001_001_002 lamports is worth 131.13 USDC, LTV 8008 bps.
const PRICE_DROP: i64 = 13_100_000_000;

#[test]
fn healthy_loan_gets_no_quote() {
    let mut env = Env::new();
    env.watch().unwrap();
    assert_eq!(env.quote()[q::VERSION], 0);
    assert_eq!(env.status(), STATUS_ACTIVE);
}

#[test]
fn quote_fund_execute_and_pay_out_exactly() {
    let mut env = Env::new();
    env.post_price(PRICE_DROP, 0, START + 60);
    env.watch().unwrap();
    let d = env.quote();
    assert_eq!(d[q::VERSION], 1);
    assert_eq!(rd_u64(&d, q::DEBT), DEBT);
    let value = loan_core::math::collateral_value_usdc(COLLATERAL, PRICE_DROP, 0, -8).unwrap();
    let to_caller = loan_core::math::wsol_to_caller(COLLATERAL, SEIZE, value).unwrap();
    assert_eq!(rd_u64(&d, q::PAYOUT), to_caller);

    env.fund(1, 1).unwrap();
    assert_eq!(env.balance(env.pool, env.usdc), DEBT);
    assert_eq!(env.balance(env.liquidator.pubkey(), env.usdc), 500_000_000 - DEBT);

    env.watch().unwrap();
    assert_eq!(env.status(), STATUS_LIQUIDATED);
    assert_eq!(env.balance(env.lender, env.usdc), DEBT);
    assert_eq!(env.balance(env.pool, env.wsol), to_caller);
    assert_eq!(env.balance(env.borrower, env.wsol), COLLATERAL - to_caller);
    assert_eq!(env.balance(env.anchor, env.wsol), 0);

    env.settle(1).unwrap();
    assert_eq!(env.balance(env.liquidator.pubkey(), env.wsol), to_caller);
    assert_eq!(env.balance(env.pool, env.wsol), 0);
    assert!(env.settle(1).is_err(), "a ticket settles once");

    // Retries after settlement are harmless.
    env.watch().unwrap();
    assert_eq!(env.balance(env.lender, env.usdc), DEBT);
}

#[test]
fn losing_and_expired_tickets_are_refunded_exactly() {
    let mut env = Env::new();
    env.post_price(PRICE_DROP, 0, START + 60);
    env.watch().unwrap();
    env.fund(1, 1).unwrap();
    env.fund(2, 1).unwrap();
    assert!(env.settle(2).is_err(), "a ticket that can still win is not refundable");
    env.watch().unwrap(); // liquidator 1 funded first and wins
    env.settle(2).unwrap();
    assert_eq!(env.balance(env.liquidator2.pubkey(), env.usdc), 500_000_000);
    assert_eq!(env.balance(env.pool, env.usdc), 0);
}

#[test]
fn an_expired_quote_moves_to_a_new_revision() {
    let mut env = Env::new();
    env.post_price(PRICE_DROP, 0, START + 60);
    env.watch().unwrap();
    env.set_time(START + 60 + 200);
    env.post_price(PRICE_DROP, 0, START + 255);
    assert!(env.fund(1, 1).is_err(), "funding an expired quote fails");
    env.watch().unwrap();
    assert_eq!(u32::from_le_bytes(env.quote()[q::REVISION..q::REVISION + 4].try_into().unwrap()), 2);
    assert!(env.fund(1, 1).is_err(), "funding the old revision fails");
    env.fund(1, 2).unwrap();
}

#[test]
fn a_recovered_price_withdraws_the_quote_and_refunds() {
    let mut env = Env::new();
    env.post_price(PRICE_DROP, 0, START + 60);
    env.watch().unwrap();
    env.fund(1, 1).unwrap();
    env.post_price(15_000_000_000, 15_000_000, START + 60);
    env.watch().unwrap();
    assert_eq!(env.quote()[q::STATE], 2);
    assert_eq!(env.status(), STATUS_ACTIVE);
    env.settle(1).unwrap();
    assert_eq!(env.balance(env.liquidator.pubkey(), env.usdc), 500_000_000);
}

#[test]
fn stale_price_does_nothing() {
    let mut env = Env::new();
    env.post_price(PRICE_DROP, 0, START - 600);
    env.watch().unwrap();
    assert_eq!(env.quote()[q::VERSION], 0);
}

#[test]
fn expiry_pays_the_lender_once() {
    let mut env = Env::new();
    env.set_time(START + 7 * 86_400);
    env.watch().unwrap();
    assert_eq!(env.status(), STATUS_EXPIRED);
    assert_eq!(env.balance(env.lender, env.wsol), COLLATERAL);
    env.watch().unwrap();
    assert_eq!(env.balance(env.lender, env.wsol), COLLATERAL);
}

#[test]
fn direct_receipt_calls_are_rejected() {
    use private_loan::receipt::{SettlementReceipt, ACTION_ESCROW_INDEX};
    let mut env = Env::new();
    let (receipt, bump) = pda(&[b"receipt", env.anchor.as_ref()]);
    let r = SettlementReceipt { loan: env.anchor, status: 0, commitment: [0; 32], settled_at: 0, bump };
    let mut data = Vec::new();
    r.try_serialize(&mut data).unwrap();
    env.put(receipt, private_loan::ID, data);
    let escrow = ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer(&env.anchor, ACTION_ESCROW_INDEX);
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    // Without the delegation program's escrow signature.
    let mut metas = private_loan::accounts::RecordReceipt { receipt, anchor: env.anchor, escrow_auth: env.anchor, escrow }.to_account_metas(None);
    metas.last_mut().unwrap().is_signer = false;
    let ix = Instruction {
        program_id: private_loan::ID,
        accounts: metas,
        data: private_loan::instruction::RecordReceipt { status: 3, commitment: [9; 32], settled_at: 1 }.data(),
    };
    assert!(env.send(ix, &attacker).is_err(), "unsigned escrow must fail");

    // With the attacker's own key standing in for the escrow.
    let mut metas = private_loan::accounts::RecordReceipt { receipt, anchor: env.anchor, escrow_auth: env.anchor, escrow: attacker.pubkey() }.to_account_metas(None);
    metas.last_mut().unwrap().is_signer = true;
    let ix = Instruction { program_id: private_loan::ID, accounts: metas, data: private_loan::instruction::RecordReceipt { status: 3, commitment: [9; 32], settled_at: 1 }.data() };
    assert!(env.send(ix, &attacker).is_err(), "a foreign signer is not the escrow");
    assert_eq!(env.svm.get_account(&receipt).unwrap().data[8 + 32], 0, "receipt untouched");
}
