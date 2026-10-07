//! LiteSVM tests for the private repayment history and its attestation (Story 26.7).
//!
//! The ER-only records (`LoanTerms`, `CreditHistory`) are placed directly: their creation is an
//! ephemeral-account CPI LiteSVM cannot run. The base-layer attestation handler is driven directly
//! to prove a call without the delegation program's escrow signature is refused. Run
//! `anchor build` first.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountDeserialize, AccountSerialize, AnchorDeserialize, AnchorSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use private_loan_v2::error::PrivateLoanError;
use private_loan_v2::history::{outcome, CreditHistory, HistoryAttestation, HistoryAttestationArgs, Outcome, HISTORY_ATTESTATION_SEED, HISTORY_SEED, MAX_HISTORY_LOANS};
use private_loan_v2::loan::{
    LedgerState, LoanAnchor, LoanTerms, STATUS_ACTIVE, STATUS_CANCELLED, STATUS_LIQUIDATED, STATUS_OVERDUE_LIQUIDATED, STATUS_PRICED_RECOVERED,
    STATUS_REFINANCED, STATUS_REPAID, STATUS_TERMINAL_CLAIMED,
};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const ID: Pubkey = private_loan_v2::ID;
const DAY: i64 = 86_400;
const START: i64 = 1_700_000_000;
const DURATION: i64 = 30 * DAY;

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

fn terms(borrower: Pubkey, status: u8, settled_ts: i64) -> LoanTerms {
    let lender = Pubkey::new_unique();
    LoanTerms {
        version: 2, origin_lender: lender, current_lender: lender, borrower, room_index: 0, request_index: 0,
        principal: 100_000_000, interest_bps: 500, duration_seconds: DURATION, early_repayment: 1, min_interest_bps: 2_500,
        grace_seconds: DAY, late_fee_bps: 100, annual_ceiling_bps: 10_000, collateral_required: 1_000_000_000, collateral_locked: 0,
        max_ltv_bps: 7_000, liquidation_ltv_bps: 8_000, revision: 1, funded_revision: 1, accepted_revision: 1, status,
        start_ts: START, ledger: LedgerState::default(), ledger_revision: 0, shortfall: 0, settled_ts, desk: Pubkey::default(),
        policy_version: 0, auditor_hash: [0; 32],
    }
}

struct Env {
    svm: LiteSVM,
    borrower: Keypair,
    caller: Keypair,
    nonce: u64,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/private_loan_v2.so");
        svm.add_program_from_file(ID, so).expect("run `anchor build` first");
        let (borrower, caller) = (Keypair::new(), Keypair::new());
        for k in [&borrower, &caller] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        Env { svm, borrower, caller, nonce: 0 }
    }

    fn put(&mut self, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len()).max(1);
        self.svm.set_account(key, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
    }

    /// A loan anchor with ER-only terms; returns the anchor.
    fn put_loan(&mut self, t: &LoanTerms) -> Pubkey {
        self.nonce += 1;
        let creator = t.origin_lender;
        let (anchor, bump) = pda(&[b"loan", creator.as_ref(), &self.nonce.to_le_bytes()]);
        let a = LoanAnchor { version: 2, creator, nonce: self.nonce, room: Pubkey::new_unique(), usdc_mint: Pubkey::new_unique(), wsol_mint: Pubkey::new_unique(), bump };
        let mut data = Vec::new();
        a.try_serialize(&mut data).unwrap();
        self.put(anchor, ID, data);
        let mut data = Vec::new();
        t.serialize(&mut data).unwrap();
        data.resize(LoanTerms::LEN, 0);
        self.put(pda(&[b"loan-terms", anchor.as_ref()]).0, ID, data);
        anchor
    }

    fn history_key(&self, borrower: Pubkey) -> (Pubkey, u8) {
        pda(&[HISTORY_SEED, borrower.as_ref()])
    }

    /// The history record as `record_history` creates it on its first write.
    fn put_history(&mut self, borrower: Pubkey) {
        let (key, bump) = self.history_key(borrower);
        let mut data = Vec::new();
        CreditHistory::new(borrower, bump).serialize(&mut data).unwrap();
        assert_eq!(data.len(), CreditHistory::LEN);
        self.put(key, ID, data);
    }

    fn history(&self, borrower: Pubkey) -> CreditHistory {
        CreditHistory::deserialize(&mut &self.svm.get_account(&self.history_key(borrower).0).unwrap().data[..]).unwrap()
    }

    fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), String> {
        self.svm.expire_blockhash();
        let tx = Transaction::new(&[signer], Message::new(&[ix], Some(&signer.pubkey())), self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs))
    }

    fn record(&mut self, anchor: Pubkey, history: Pubkey) -> Result<(), String> {
        let ix = Instruction {
            program_id: ID,
            accounts: private_loan_v2::accounts::RecordHistory {
                caller: self.caller.pubkey(),
                anchor,
                terms: pda(&[b"loan-terms", anchor.as_ref()]).0,
                history,
                history_permission: None,
                vault: None,
                magic_program: None,
                permission_program: None,
            }
            .to_account_metas(None),
            data: private_loan_v2::instruction::RecordHistory {}.data(),
        };
        let c = self.caller.insecure_clone();
        self.send(ix, &c)
    }
}

#[test]
fn outcomes_follow_the_research_classes() {
    let b = Pubkey::new_unique();
    let maturity = START + DURATION;
    assert_eq!(outcome(&terms(b, STATUS_REPAID, maturity)), Some(Outcome::OnTime));
    assert_eq!(outcome(&terms(b, STATUS_REPAID, maturity + 1)), Some(Outcome::Late));
    assert_eq!(outcome(&terms(b, STATUS_LIQUIDATED, maturity)), Some(Outcome::Liquidated));
    for s in [STATUS_OVERDUE_LIQUIDATED, STATUS_PRICED_RECOVERED, STATUS_TERMINAL_CLAIMED] {
        assert_eq!(outcome(&terms(b, s, maturity + 3 * DAY)), Some(Outcome::Defaulted));
    }
    assert_eq!(outcome(&terms(b, STATUS_REFINANCED, maturity)), Some(Outcome::Refinanced));
    assert_eq!(outcome(&terms(b, STATUS_ACTIVE, 0)), None);
    assert_eq!(outcome(&terms(b, STATUS_CANCELLED, START)), None);
}

#[test]
fn anyone_records_each_settled_loan_once() {
    let mut env = Env::new();
    let b = env.borrower.pubkey();
    env.put_history(b);
    let history = env.history_key(b).0;
    let maturity = START + DURATION;
    let loans = [
        env.put_loan(&terms(b, STATUS_REPAID, maturity - DAY)),
        env.put_loan(&terms(b, STATUS_REPAID, maturity + DAY / 2)),
        env.put_loan(&terms(b, STATUS_TERMINAL_CLAIMED, maturity + 9 * DAY)),
        env.put_loan(&terms(b, STATUS_LIQUIDATED, START + DAY)),
        env.put_loan(&terms(b, STATUS_REFINANCED, START + DAY)),
    ];
    for l in loans {
        env.record(l, history).unwrap();
    }
    let h = env.history(b);
    assert_eq!((h.on_time, h.late, h.defaulted, h.liquidated, h.refinanced, h.count), (1, 1, 1, 1, 1, 5));
    assert_eq!(h.repaid(), 2);
    assert_eq!(h.last_settled_at, maturity + 9 * DAY);
    // Each loan counts once.
    assert_err(env.record(loans[2], history), PrivateLoanError::HistoryAlreadyCounted);
    // An open or cancelled loan never counts.
    let open = env.put_loan(&terms(b, STATUS_ACTIVE, 0));
    assert_err(env.record(open, history), PrivateLoanError::WrongStatus);
    let cancelled = env.put_loan(&terms(b, STATUS_CANCELLED, START));
    assert_err(env.record(cancelled, history), PrivateLoanError::WrongStatus);
    // Another borrower's loan cannot be written into this history.
    let other = env.put_loan(&terms(Pubkey::new_unique(), STATUS_REPAID, maturity));
    assert_err(env.record(other, history), PrivateLoanError::InvalidRecord);
}

#[test]
fn history_without_a_record_needs_the_creation_accounts() {
    let mut env = Env::new();
    let b = env.borrower.pubkey();
    let l = env.put_loan(&terms(b, STATUS_REPAID, START + DAY));
    let history = env.history_key(b).0;
    assert_err(env.record(l, history), PrivateLoanError::InvalidRecord);
}

#[test]
fn a_full_history_refuses_more_loans() {
    let mut env = Env::new();
    let b = env.borrower.pubkey();
    env.put_history(b);
    let history = env.history_key(b).0;
    for _ in 0..MAX_HISTORY_LOANS {
        let l = env.put_loan(&terms(b, STATUS_REPAID, START + DAY));
        env.record(l, history).unwrap();
    }
    let l = env.put_loan(&terms(b, STATUS_REPAID, START + DAY));
    assert_err(env.record(l, history), PrivateLoanError::HistoryFull);
}

#[test]
fn attestation_opens_empty_and_only_the_post_commit_action_writes_it() {
    let mut env = Env::new();
    let b = env.borrower.insecure_clone();
    let (attestation, bump) = pda(&[HISTORY_ATTESTATION_SEED, b.pubkey().as_ref()]);
    let ix = Instruction {
        program_id: ID,
        accounts: private_loan_v2::accounts::OpenHistoryAttestation { borrower: b.pubkey(), attestation, system_program: anchor_lang::system_program::ID }
            .to_account_metas(None),
        data: private_loan_v2::instruction::OpenHistoryAttestation {}.data(),
    };
    env.send(ix, &b).unwrap();
    let acc = env.svm.get_account(&attestation).unwrap();
    assert_eq!(acc.owner, ID);
    let at = HistoryAttestation::try_deserialize(&mut &acc.data[..]).unwrap();
    assert_eq!((at.version, at.borrower, at.repaid, at.rollup_slot, at.bump), (1, b.pubkey(), 0, 0, bump));

    // A direct call, even signed by a fresh key posing as the escrow, is refused: the escrow
    // must be the delegation program's PDA for a private_loan_v2 loan anchor.
    let creator = Pubkey::new_unique();
    let anchor = pda(&[b"loan", creator.as_ref(), &1u64.to_le_bytes()]).0;
    let fake_escrow = Keypair::new();
    env.svm.airdrop(&fake_escrow.pubkey(), 1_000_000_000).unwrap();
    let args = HistoryAttestationArgs {
        borrower: b.pubkey(), anchor_creator: creator, anchor_nonce: 1, repaid: 9, on_time: 9, late: 0, liquidated: 0, defaulted: 0,
        loans_counted: 9, rollup_slot: 10, attested_at: START,
    };
    let ix = Instruction {
        program_id: ID,
        accounts: private_loan_v2::accounts::RecordHistoryAttestation {
            attestation,
            anchor,
            destination_program: ID,
            escrow_auth: anchor,
            escrow: fake_escrow.pubkey(),
        }
        .to_account_metas(None),
        data: private_loan_v2::instruction::RecordHistoryAttestation { args }.data(),
    };
    assert_err(env.send(ix, &fake_escrow), PrivateLoanError::Unauthorized);
    let at = HistoryAttestation::try_deserialize(&mut &env.svm.get_account(&attestation).unwrap().data[..]).unwrap();
    assert_eq!(at.repaid, 0);
}
