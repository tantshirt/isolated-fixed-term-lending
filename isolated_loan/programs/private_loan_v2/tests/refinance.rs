//! LiteSVM tests for private V2 refinance (Story 26.1).
//!
//! `refinance` runs without the ER runtime once its records exist, so both ER-only `LoanTerms`
//! and the new request's deal record are placed directly (the deal record's creation is the ER
//! permission CPI that LiteSVM cannot run; `accept_loan` shares the same code). The Pyth account
//! is owned by the real receiver id. Run `anchor build` first.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountSerialize, AnchorDeserialize, AnchorSerialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address as ata;
use litesvm::LiteSVM;
use loan_core::accounting as acc;
use private_loan_v2::error::PrivateLoanError;
use private_loan_v2::loan::{LedgerState, LoanAnchor, LoanTerms, STATUS_ACTIVE, STATUS_FUNDED, STATUS_REFINANCED, STATUS_REPAID};
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
const USD: i64 = 100_000_000;
const RECEIVER: Pubkey = loan_core::constants::PYTH_RECEIVER_PROGRAM_ID;
const NEW_PRINCIPAL: u64 = 90_000_000;
const NEW_COLLATERAL: u64 = 950_000_000;

fn pda(seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, &ID)
}

fn code(e: PrivateLoanError) -> String {
    format!("Custom({})", u32::from(e))
}

fn assert_err(r: Result<(), String>, e: PrivateLoanError) {
    let msg = r.expect_err("expected the instruction to fail");
    assert!(msg.contains(&code(e)), "expected {e:?} ({}), got {msg}", code(e));
}

fn terms(lender: Pubkey, borrower: Pubkey, principal: u64, collateral: u64, status: u8, start: i64) -> LoanTerms {
    let mut t = LoanTerms {
        version: 2, origin_lender: lender, current_lender: lender, borrower, room_index: 0, request_index: 0,
        principal, interest_bps: 500, duration_seconds: 30 * DAY, early_repayment: 1, min_interest_bps: 2_500,
        grace_seconds: DAY, late_fee_bps: 100, annual_ceiling_bps: 10_000, collateral_required: collateral, collateral_locked: 0,
        max_ltv_bps: 7_000, liquidation_ltv_bps: 8_000, revision: 1, funded_revision: 1, accepted_revision: 0, status,
        start_ts: start, ledger: LedgerState::default(), ledger_revision: 0, shortfall: 0, settled_ts: 0, desk: Pubkey::default(),
        policy_version: 0, auditor_hash: [0; 32],
    };
    if status == STATUS_ACTIVE {
        t.collateral_locked = collateral;
        t.accepted_revision = 1;
        t.ledger = acc::open(&t.core_terms().unwrap()).unwrap().into();
    }
    t
}

struct Loan {
    anchor: Pubkey,
    terms: Pubkey,
    room: Pubkey,
}

struct Env {
    svm: LiteSVM,
    borrower: Keypair,
    old_lender: Pubkey,
    new_lender: Pubkey,
    usdc: Pubkey,
    wsol: Pubkey,
    old: Loan,
    new: Loan,
    price: Pubkey,
    now: i64,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/private_loan_v2.so");
        svm.add_program_from_file(ID, so).expect("run `anchor build` first");
        let borrower = Keypair::new();
        svm.airdrop(&borrower.pubkey(), 10_000_000_000).unwrap();
        let (usdc, wsol) = (Pubkey::new_unique(), Pubkey::new_unique());
        let (old_lender, new_lender) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut env = Env {
            svm,
            borrower,
            old_lender,
            new_lender,
            usdc,
            wsol,
            old: Loan { anchor: Pubkey::default(), terms: Pubkey::default(), room: Pubkey::new_unique() },
            new: Loan { anchor: Pubkey::default(), terms: Pubkey::default(), room: Pubkey::new_unique() },
            price: Pubkey::new_unique(),
            now: START,
        };
        env.at(START);
        env.put_mint(usdc, 6);
        env.put_mint(wsol, 9);
        let b = env.borrower.pubkey();
        let (old_room, new_room) = (env.old.room, env.new.room);
        env.old = env.put_loan(old_lender, 1, old_room, &terms(old_lender, b, PRINCIPAL, COLLATERAL, STATUS_ACTIVE, START));
        env.new = env.put_loan(new_lender, 2, new_room, &terms(new_lender, b, NEW_PRINCIPAL, NEW_COLLATERAL, STATUS_FUNDED, 0));
        let (old_anchor, new_anchor) = (env.old.anchor, env.new.anchor);
        env.put_ata(wsol, old_anchor, COLLATERAL);
        env.put_ata(usdc, new_anchor, NEW_PRINCIPAL);
        env.put_ata(wsol, new_anchor, 0);
        env.put_ata(usdc, old_lender, 0);
        env.put_ata(usdc, b, 500_000_000);
        env.put_ata(wsol, b, 0);
        // The new request's deal record, already pointing at the new loan.
        env.put_deal(new_anchor);
        env.at(START + DAY);
        env.price_usd(150, 150);
        env
    }

    fn put_loan(&mut self, creator: Pubkey, nonce: u64, room: Pubkey, t: &LoanTerms) -> Loan {
        let (anchor, bump) = pda(&[b"loan", creator.as_ref(), &nonce.to_le_bytes()]);
        let a = LoanAnchor { version: 2, creator, nonce, room, usdc_mint: self.usdc, wsol_mint: self.wsol, bump };
        let mut data = Vec::new();
        a.try_serialize(&mut data).unwrap();
        self.put(anchor, ID, data);
        let loan = Loan { anchor, terms: pda(&[b"loan-terms", anchor.as_ref()]).0, room };
        self.write_terms(loan.terms, t);
        loan
    }

    fn deal_key(&self) -> Pubkey {
        pda(&[b"room-deal", self.new.room.as_ref(), &0u32.to_le_bytes()]).0
    }

    fn put_deal(&mut self, accepted: Pubkey) {
        let key = self.deal_key();
        self.put(key, ID, accepted.to_bytes().to_vec());
    }

    fn at(&mut self, ts: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = ts;
        self.svm.set_sysvar(&clock);
        self.now = ts;
    }

    fn write_terms(&mut self, key: Pubkey, t: &LoanTerms) {
        let mut data = Vec::new();
        t.serialize(&mut data).unwrap();
        data.resize(LoanTerms::LEN, 0);
        self.put(key, ID, data);
    }

    fn read(&self, key: Pubkey) -> LoanTerms {
        LoanTerms::deserialize(&mut &self.svm.get_account(&key).unwrap().data[..]).unwrap()
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

    fn refinance_as(&mut self, signer: &Keypair, revision: u32, auditor_hash: [u8; 32], max: u64) -> Result<(), String> {
        let b = self.borrower.pubkey();
        let ix = Instruction {
            program_id: ID,
            accounts: private_loan_v2::accounts::Refinance {
                borrower: signer.pubkey(),
                old_anchor: self.old.anchor,
                old_terms: self.old.terms,
                old_loan_wsol: ata(&self.old.anchor, &self.wsol),
                old_lender_usdc: ata(&self.old_lender, &self.usdc),
                new_anchor: self.new.anchor,
                new_terms: self.new.terms,
                new_loan_usdc: ata(&self.new.anchor, &self.usdc),
                new_loan_wsol: ata(&self.new.anchor, &self.wsol),
                borrower_usdc: ata(&b, &self.usdc),
                borrower_wsol: ata(&b, &self.wsol),
                price_update: self.price,
                token_program: TOKEN,
                deal: Some(self.deal_key()),
                deal_permission: None,
                vault: None,
                magic_program: None,
                permission_program: None,
                terms_permission: None,
                desk_policy: None,
            }
            .to_account_metas(None),
            data: private_loan_v2::instruction::Refinance { revision, auditor_hash, max_contribution: max }.data(),
        };
        self.svm.expire_blockhash();
        let tx = Transaction::new(&[signer], Message::new(&[ix], Some(&signer.pubkey())), self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs))
    }

    fn refinance(&mut self, max: u64) -> Result<(), String> {
        let b = self.borrower.insecure_clone();
        self.refinance_as(&b, 1, [0; 32], max)
    }

    fn payoff(&self) -> u64 {
        self.read(self.old.terms).payoff(self.now).unwrap()
    }
}

#[test]
fn private_refinance_pays_exactly_the_payoff_and_moves_custody() {
    let mut env = Env::new();
    let b = env.borrower.pubkey();
    let payoff = env.payoff();
    assert_eq!(payoff, 101_250_000);
    let contribution = payoff - NEW_PRINCIPAL;
    assert_err(env.refinance(contribution - 1), PrivateLoanError::PaymentAboveLimit);
    let b0 = env.balance(b, env.usdc);
    env.refinance(contribution).unwrap();

    assert_eq!(env.balance(env.old_lender, env.usdc), payoff, "the old lender receives exactly payoff_old");
    assert_eq!(b0 - env.balance(b, env.usdc), contribution);
    assert_eq!(env.balance(env.new.anchor, env.usdc), 0, "the new principal left the new loan's custody");
    assert_eq!(env.balance(env.new.anchor, env.wsol), NEW_COLLATERAL);
    assert_eq!(env.balance(env.old.anchor, env.wsol), 0);
    assert_eq!(env.balance(b, env.wsol), COLLATERAL - NEW_COLLATERAL, "collateral above the new requirement comes back");

    let old = env.read(env.old.terms);
    assert_eq!((old.status, old.settled_ts, old.collateral_locked, old.ledger.outstanding_principal), (STATUS_REFINANCED, START + DAY, 0, 0));
    assert_ne!(old.status, STATUS_REPAID);
    let new = env.read(env.new.terms);
    assert_eq!((new.status, new.start_ts, new.collateral_locked, new.accepted_revision), (STATUS_ACTIVE, START + DAY, NEW_COLLATERAL, 1));
    assert_eq!(new.ledger.outstanding_principal, NEW_PRINCIPAL);

    // Exactly one terminal state: the old loan cannot refinance again.
    assert_err(env.refinance(u64::MAX), PrivateLoanError::WrongStatus);
}

#[test]
fn private_refinance_needs_fresh_consent_to_the_new_terms() {
    let mut env = Env::new();
    let b = env.borrower.insecure_clone();
    assert_err(env.refinance_as(&b, 2, [0; 32], u64::MAX), PrivateLoanError::StaleRevision);
    assert_err(env.refinance_as(&b, 1, [7; 32], u64::MAX), PrivateLoanError::AuditorMismatch);
    // Someone else cannot move the borrower's loan.
    let other = Keypair::new();
    env.svm.airdrop(&other.pubkey(), 1_000_000_000).unwrap();
    assert_err(env.refinance_as(&other, 1, [0; 32], u64::MAX), PrivateLoanError::NotBorrower);
    env.refinance(u64::MAX).unwrap();
}

#[test]
fn private_refinance_rejects_cash_out_and_overdue_loans() {
    let mut env = Env::new();
    let b = env.borrower.pubkey();
    let mut t = terms(env.new_lender, b, 101_250_001, NEW_COLLATERAL, STATUS_FUNDED, 0);
    let key = env.new.terms;
    env.write_terms(key, &t);
    let anchor = env.new.anchor;
    let usdc = env.usdc;
    env.put_ata(usdc, anchor, 101_250_001);
    assert_err(env.refinance(u64::MAX), PrivateLoanError::RefinanceCashOut);
    t.principal = NEW_PRINCIPAL;
    env.write_terms(key, &t);
    let grace_end = env.read(env.old.terms).core_terms().unwrap().grace_end();
    env.at(grace_end);
    env.price_usd(150, 150);
    assert_err(env.refinance(u64::MAX), PrivateLoanError::RefinanceClosed);
    env.at(grace_end - 1);
    env.price_usd(150, 150);
    env.refinance(u64::MAX).unwrap();
}

#[test]
fn private_refinance_checks_the_new_ltv_and_one_accepted_proposal() {
    let mut env = Env::new();
    // 95.4 USDC of new exposure against 0.95 wSOL at 120 (~114 USDC) is above 70%.
    env.price_usd(120, 120);
    assert_err(env.refinance(u64::MAX), PrivateLoanError::InsufficientCollateral);
    env.price_usd(150, 150);
    // Another proposal for the same request was accepted first.
    env.put_deal(Pubkey::new_unique());
    assert_err(env.refinance(u64::MAX), PrivateLoanError::CompetingOfferAccepted);
    let new_anchor = env.new.anchor;
    env.put_deal(new_anchor);
    env.refinance(u64::MAX).unwrap();
    assert_eq!(env.read(env.old.terms).status, STATUS_REFINANCED);
}
