//! Story 27.1: `request_tier` on LiteSVM.
//!
//! The Arcium accounts the instruction deserializes (MXE account, cluster 456, fee pool, Arcium
//! clock, a computation definition) are real Devnet accounts in `fixtures/arcium-devnet.json`,
//! written at this program's PDAs. The Arcium program itself is not loaded: a stand-in executable
//! sits at its address, so a request that passes every ZenLo check ends at the Arcium CPI. These
//! tests prove what `request_tier` refuses and that a valid request reaches the queue CPI; they do
//! not run MPC (that needs `arcium test` with Docker, see docs/architecture.md).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::accounts::MXEAccount;
use base64::Engine;
use credit_tier::{HISTORY_ATTESTATION_SEED, MAX_ATTESTATION_AGE_SECONDS, PRIVATE_LOAN_V2_ID, TIER_RESULT_SEED};
use isolated_loan_v2::config::{Config, CONFIG_SEED};
use isolated_loan_v2::credit::{CreditConfig, CREDIT_SEED, SAS_PROGRAM_ID};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use zenlo_credit_mxe::{CreditMxeError, ID, ID_CONST};

const NOW: i64 = 1_800_000_000;
const DAY: i64 = 86_400;
const SYSTEM_PROGRAM: Pubkey = pubkey!("11111111111111111111111111111111");

#[derive(serde::Deserialize)]
struct Fixture {
    owner: String,
    data: String,
}

#[derive(serde::Deserialize)]
struct Fixtures {
    cluster: Fixture,
    fee_pool: Fixture,
    clock: Fixture,
    mxe: Fixture,
    comp_def: Fixture,
}

fn bytes(f: &Fixture) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(&f.data).unwrap()
}

struct Env {
    svm: LiteSVM,
    borrower: Keypair,
    issuer: Keypair,
    credential: Pubkey,
    schema: Pubkey,
    mxe: MXEAccount,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/zenlo_credit_mxe.so");
        svm.add_program_from_file(ID, so).expect("run `arcium build` (or `anchor build`) in programs/zenlo_credit_mxe first");
        // Stand-in executable at the Arcium program address (see the module note).
        svm.add_program_from_file(ARCIUM_PROG_ID, so).unwrap();
        let fx: Fixtures = serde_json::from_str(include_str!("fixtures/arcium-devnet.json")).unwrap();
        let arcium: Pubkey = fx.cluster.owner.parse().unwrap();
        assert_eq!(arcium, ARCIUM_PROG_ID);
        let mxe_data = bytes(&fx.mxe);
        let mxe = MXEAccount::try_deserialize(&mut &mxe_data[..]).expect("fixture MXE account matches arcium-client 0.15");
        assert_eq!(mxe.cluster, 456);
        let mut env = Env { svm, borrower: Keypair::new(), issuer: Keypair::new(), credential: Pubkey::new_unique(), schema: Pubkey::new_unique(), mxe };
        env.put(derive_mxe_pda!(), ARCIUM_PROG_ID, mxe_data);
        env.put(derive_cluster_pda!(env.mxe), ARCIUM_PROG_ID, bytes(&fx.cluster));
        env.put(ARCIUM_FEE_POOL_ACCOUNT_ADDRESS, ARCIUM_PROG_ID, bytes(&fx.fee_pool));
        env.put(ARCIUM_CLOCK_ACCOUNT_ADDRESS, ARCIUM_PROG_ID, bytes(&fx.clock));
        env.put(derive_comp_def_pda!(comp_def_offset("tier")), ARCIUM_PROG_ID, bytes(&fx.comp_def));
        env.svm.airdrop(&env.borrower.pubkey(), 10_000_000_000).unwrap();
        let mut clock: Clock = env.svm.get_sysvar();
        clock.unix_timestamp = NOW;
        env.svm.set_sysvar(&clock);
        env.put_loan_config(true);
        env
    }

    fn put(&mut self, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len()).max(1);
        self.svm.set_account(key, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
    }

    /// `isolated_loan_v2` `Config` (issuer = `self.issuer`) and `CreditConfig`.
    fn put_loan_config(&mut self, enabled: bool) {
        let (config_key, config_bump) = Pubkey::find_program_address(&[CONFIG_SEED], &isolated_loan_v2::ID);
        let k = Pubkey::new_unique;
        let config = Config {
            version: 1,
            authorities: governance::Authorities { governance: k(), ai_admin: k(), ai_worker: k(), liquidation_pool_admin: k(), credential_issuer: self.issuer.pubkey(), keeper: k() },
            bump: config_bump,
        };
        let mut data = Vec::new();
        config.try_serialize(&mut data).unwrap();
        self.put(config_key, isolated_loan_v2::ID, data);
        let (credit_key, credit_bump) = Pubkey::find_program_address(&[CREDIT_SEED], &isolated_loan_v2::ID);
        let credit = CreditConfig { version: 1, enabled, sas_program: SAS_PROGRAM_ID, credential: self.credential, schema: self.schema, bump: credit_bump, reserved: [0; 32] };
        let mut data = Vec::new();
        credit.try_serialize(&mut data).unwrap();
        self.put(credit_key, isolated_loan_v2::ID, data);
    }

    /// The borrower's SAS credit credential at its SAS PDA, for `band` (= credential tier).
    fn put_sas(&mut self, subject: Pubkey, band: u8, expiry: i64) -> Pubkey {
        let key = Pubkey::find_program_address(&[b"attestation", self.credential.as_ref(), self.schema.as_ref(), subject.as_ref()], &SAS_PROGRAM_ID).0;
        let mut payload = vec![band];
        payload.extend_from_slice(&expiry.to_le_bytes());
        let mut v = vec![2u8];
        for k in [subject, self.credential, self.schema] {
            v.extend_from_slice(k.as_ref());
        }
        v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        v.extend_from_slice(&payload);
        v.extend_from_slice(self.issuer.pubkey().as_ref());
        v.extend_from_slice(&0i64.to_le_bytes());
        v.extend_from_slice(Pubkey::default().as_ref());
        self.put(key, SAS_PROGRAM_ID, v);
        key
    }

    /// A `HistoryAttestation` for `named` written at `["credit-attestation", at_borrower]`.
    #[allow(clippy::too_many_arguments)]
    fn put_history(&mut self, at_borrower: Pubkey, named: Pubkey, owner: Pubkey, on_time: u32, late: u32, defaulted: u32, rollup_slot: u64, attested_at: i64) -> Pubkey {
        let (key, bump) = Pubkey::find_program_address(&[HISTORY_ATTESTATION_SEED, at_borrower.as_ref()], &PRIVATE_LOAN_V2_ID);
        let mut v = credit_tier::HISTORY_ATTESTATION_DISCRIMINATOR.to_vec();
        v.push(1);
        v.extend_from_slice(named.as_ref());
        for n in [on_time + late, on_time, late, 0, defaulted] {
            v.extend_from_slice(&n.to_le_bytes());
        }
        v.extend_from_slice(&((on_time + late + defaulted) as u16).to_le_bytes());
        v.extend_from_slice(&rollup_slot.to_le_bytes());
        v.extend_from_slice(&attested_at.to_le_bytes());
        v.push(bump);
        self.put(key, owner, v);
        key
    }

    fn history_key(b: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[HISTORY_ATTESTATION_SEED, b.as_ref()], &PRIVATE_LOAN_V2_ID).0
    }

    fn request(&mut self, history: Pubkey, sas: Pubkey) -> std::result::Result<(), String> {
        let offset = 7u64;
        let b = self.borrower.pubkey();
        let accounts = zenlo_credit_mxe::accounts::RequestTier {
            borrower: b,
            history_attestation: history,
            loan_config: Pubkey::find_program_address(&[CONFIG_SEED], &isolated_loan_v2::ID).0,
            credit_config: Pubkey::find_program_address(&[CREDIT_SEED], &isolated_loan_v2::ID).0,
            sas_attestation: sas,
            tier_result: Pubkey::find_program_address(&[TIER_RESULT_SEED, b.as_ref()], &ID).0,
            sign_pda_account: derive_sign_pda!(),
            mxe_account: derive_mxe_pda!(),
            mempool_account: derive_mempool_pda!(self.mxe),
            executing_pool: derive_execpool_pda!(self.mxe),
            computation_account: derive_comp_pda!(offset, self.mxe),
            comp_def_account: derive_comp_def_pda!(comp_def_offset("tier")),
            cluster_account: derive_cluster_pda!(self.mxe),
            pool_account: ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
            clock_account: ARCIUM_CLOCK_ACCOUNT_ADDRESS,
            system_program: SYSTEM_PROGRAM,
            arcium_program: ARCIUM_PROG_ID,
        }
        .to_account_metas(None);
        let ix = Instruction { program_id: ID, accounts, data: zenlo_credit_mxe::instruction::RequestTier { computation_offset: offset }.data() };
        self.svm.expire_blockhash();
        let tx = Transaction::new(&[&self.borrower], Message::new(&[ix], Some(&b)), self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs))
    }
}

fn code(e: CreditMxeError) -> String {
    format!("Custom({})", u32::from(e))
}

fn assert_err(r: std::result::Result<(), String>, e: CreditMxeError) {
    let want = code(e);
    assert!(r.as_ref().err().is_some_and(|m| m.contains(&want)), "expected {want}, got {r:?}");
}

#[test]
fn rejects_missing_foreign_mismatched_unwritten_and_stale_attestations() {
    let mut env = Env::new();
    let b = env.borrower.pubkey();
    let sas = env.put_sas(b, 3, NOW + 90 * DAY);

    // Missing: no account at the borrower's attestation PDA.
    assert_err(env.request(Env::history_key(&b), sas), CreditMxeError::AttestationMissing);

    // Foreign: the right bytes at the right address, owned by another program.
    let h = env.put_history(b, b, Pubkey::new_unique(), 6, 0, 0, 10, NOW - DAY);
    assert_err(env.request(h, sas), CreditMxeError::AttestationWrongOwner);

    // Mismatched: another borrower's genuine attestation offered for this borrower.
    let other = Pubkey::new_unique();
    let theirs = env.put_history(other, other, PRIVATE_LOAN_V2_ID, 9, 0, 0, 10, NOW - DAY);
    assert_err(env.request(theirs, sas), CreditMxeError::AttestationMismatch);
    // ...or a record naming someone else at this borrower's address.
    let h = env.put_history(b, other, PRIVATE_LOAN_V2_ID, 9, 0, 0, 10, NOW - DAY);
    assert_err(env.request(h, sas), CreditMxeError::AttestationMismatch);

    // Opened by the borrower but never written by the rollup.
    let h = env.put_history(b, b, PRIVATE_LOAN_V2_ID, 0, 0, 0, 0, 0);
    assert_err(env.request(h, sas), CreditMxeError::AttestationNotWritten);

    // Stale: attested more than 30 days ago, or dated in the future.
    let h = env.put_history(b, b, PRIVATE_LOAN_V2_ID, 6, 0, 0, 10, NOW - MAX_ATTESTATION_AGE_SECONDS - 1);
    assert_err(env.request(h, sas), CreditMxeError::AttestationStale);
    let h = env.put_history(b, b, PRIVATE_LOAN_V2_ID, 6, 0, 0, 10, NOW + 3_600);
    assert_err(env.request(h, sas), CreditMxeError::AttestationStale);
}

#[test]
fn income_band_comes_only_from_a_valid_sas_credential() {
    let mut env = Env::new();
    let b = env.borrower.pubkey();
    let h = env.put_history(b, b, PRIVATE_LOAN_V2_ID, 6, 0, 0, 10, NOW - DAY);
    // No credential.
    let missing = Pubkey::find_program_address(&[b"attestation", env.credential.as_ref(), env.schema.as_ref(), b.as_ref()], &SAS_PROGRAM_ID).0;
    assert_err(env.request(h, missing), CreditMxeError::IncomeCredentialRequired);
    // Expired credential.
    let sas = env.put_sas(b, 3, NOW);
    assert_err(env.request(h, sas), CreditMxeError::IncomeCredentialRequired);
    // Another wallet's credential.
    let theirs = env.put_sas(Pubkey::new_unique(), 3, NOW + DAY);
    assert_err(env.request(h, theirs), CreditMxeError::IncomeCredentialRequired);
    // Pilot disabled.
    let sas = env.put_sas(b, 3, NOW + DAY);
    env.put_loan_config(false);
    assert_err(env.request(h, sas), CreditMxeError::IncomeCredentialRequired);
}

#[test]
fn a_valid_request_passes_every_check_and_reaches_the_arcium_queue_cpi() {
    let mut env = Env::new();
    let b = env.borrower.pubkey();
    let h = env.put_history(b, b, PRIVATE_LOAN_V2_ID, 6, 0, 0, 10, NOW - DAY);
    let sas = env.put_sas(b, 3, NOW + 90 * DAY);
    let r = env.request(h, sas);
    // The stand-in at the Arcium address rejects the queue instruction, so the transaction fails,
    // but only after `request_tier` invoked Arcium: every ZenLo check passed.
    let logs = r.expect_err("the stand-in Arcium program cannot queue");
    assert!(logs.contains(&format!("Program {} invoke [2]", ARCIUM_PROG_ID)), "{logs}");
    for e in [
        CreditMxeError::AttestationMissing,
        CreditMxeError::AttestationWrongOwner,
        CreditMxeError::AttestationMismatch,
        CreditMxeError::AttestationNotWritten,
        CreditMxeError::AttestationStale,
        CreditMxeError::IncomeCredentialRequired,
        CreditMxeError::TierResultMismatch,
    ] {
        assert!(!logs.contains(&code(e)), "{logs}");
    }
}
