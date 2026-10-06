//! Offline regression tests. Build private_loan.so before running.
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use private_loan::ai::{layout, AiConfig, STATUS_ANSWERED, STATUS_PENDING, STATUS_PROCESSING};
use solana_account::Account;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const NOW: i64 = 1_700_000_000;
const BINARY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/private_loan.so");

struct Env {
    svm: LiteSVM,
    worker: Keypair,
    config: Pubkey,
    request: Pubkey,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(private_loan::ID, BINARY).expect("build private_loan first");
        let worker = Keypair::new();
        svm.airdrop(&worker.pubkey(), 10_000_000_000).unwrap();
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = NOW;
        svm.set_sysvar(&clock);
        let (config, bump) = Pubkey::find_program_address(&[b"ai-config"], &private_loan::ID);
        let mut bytes = vec![];
        AiConfig { worker: worker.pubkey(), enabled: true, bump }.try_serialize(&mut bytes).unwrap();
        let request = Pubkey::new_unique();
        let mut e = Self { svm, worker, config, request };
        e.put(config, bytes, private_loan::ID);
        let mut data = vec![0; layout::LEN];
        data[0] = 1;
        data[layout::DEADLINE..layout::DEADLINE + 8].copy_from_slice(&(NOW + 60).to_le_bytes());
        e.put(request, data, private_loan::ID);
        e
    }

    fn put(&mut self, key: Pubkey, data: Vec<u8>, owner: Pubkey) {
        self.svm.set_account(key, Account { lamports: 100_000_000, data, owner, executable: false, rent_epoch: 0 }).unwrap();
    }

    fn claim(&self, nonce: u8) -> Instruction {
        Instruction { program_id: private_loan::ID,
            accounts: private_loan::accounts::ClaimAiRequest { worker: self.worker.pubkey(), config: self.config, request: self.request }.to_account_metas(None),
            data: private_loan::instruction::ClaimAiRequest { claim_id: [nonce; 32] }.data() }
    }

    fn callback(&self) -> Instruction {
        Instruction { program_id: private_loan::ID,
            accounts: private_loan::accounts::AiCallback { worker: self.worker.pubkey(), config: self.config, request: self.request, terms: None }.to_account_metas(None),
            data: private_loan::instruction::AiCallback { result: b"answer".to_vec() }.data() }
    }

    fn send(&mut self, ix: Instruction) -> Result<(), String> {
        self.svm.expire_blockhash();
        let tx = Transaction::new(&[&self.worker], Message::new(&[ix], Some(&self.worker.pubkey())), self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
    }

    fn status(&self) -> u8 { self.svm.get_account(&self.request).unwrap().data[layout::STATUS] }
}

#[test]
fn only_one_claim_wins_and_callback_requires_claim() {
    let mut e = Env::new();
    assert!(e.send(e.callback()).is_err());
    assert_eq!(e.status(), STATUS_PENDING);
    e.send(e.claim(1)).unwrap();
    assert_eq!(e.status(), STATUS_PROCESSING);
    assert!(e.send(e.claim(2)).is_err());
    e.send(e.callback()).unwrap();
    assert_eq!(e.status(), STATUS_ANSWERED);
    assert!(e.send(e.callback()).is_err());
    assert!(e.send(e.claim(3)).is_err());
}

#[test]
fn claim_checks_worker_enabled_deadline_and_exact_record() {
    for variant in 0..6 {
        let mut e = Env::new();
        let mut record = e.svm.get_account(&e.request).unwrap();
        match variant {
            0 | 1 => {
                let bump = Pubkey::find_program_address(&[b"ai-config"], &private_loan::ID).1;
                let mut bytes = vec![];
                AiConfig { worker: if variant == 0 { Pubkey::new_unique() } else { e.worker.pubkey() }, enabled: variant != 1, bump }.try_serialize(&mut bytes).unwrap();
                e.put(e.config, bytes, private_loan::ID);
            }
            2 => record.data[layout::DEADLINE..layout::DEADLINE + 8].copy_from_slice(&(NOW - 1).to_le_bytes()),
            3 => record.data.push(0),
            4 => record.data[0] = 2,
            _ => record.owner = anchor_lang::system_program::ID,
        }
        e.svm.set_account(e.request, record).unwrap();
        assert!(e.send(e.claim(1)).is_err(), "variant {variant}");
        assert_eq!(e.status(), STATUS_PENDING);
    }
}

#[test]
fn expired_claim_cannot_complete() {
    let mut e = Env::new();
    e.send(e.claim(1)).unwrap();
    let mut clock: Clock = e.svm.get_sysvar();
    clock.unix_timestamp = NOW + 61;
    e.svm.set_sysvar(&clock);
    assert!(e.send(e.callback()).is_err());
    assert_eq!(e.status(), STATUS_PROCESSING);
}

#[test]
fn sponsored_first_draw_rejects_existing_scenario_before_vrf() {
    let mut e = Env::new();
    let learner = e.worker.pubkey();
    let (scenario, bump) = Pubkey::find_program_address(&[b"lab", learner.as_ref()], &private_loan::ID);
    let mut bytes = vec![];
    private_loan::lab::LabScenario { learner, randomness: [7; 32], status: 1, rounds: 1, requested_at: NOW, bump }.try_serialize(&mut bytes).unwrap();
    e.put(scenario, bytes.clone(), private_loan::ID);
    let vrf = ephemeral_rollups_sdk::vrf::consts::VRF_PROGRAM_ID;
    e.svm.add_program_from_file(vrf, BINARY).unwrap();
    let ix = Instruction { program_id: private_loan::ID,
        accounts: private_loan::accounts::RequestFirstScenario {
            learner, scenario,
            oracle_queue: ephemeral_rollups_sdk::vrf::consts::DEFAULT_QUEUE,
            system_program: anchor_lang::system_program::ID,
            program_identity: Pubkey::find_program_address(&[b"identity"], &private_loan::ID).0,
            vrf_program: vrf,
            slot_hashes: ephemeral_rollups_sdk::vrf::compat::slot_hashes::ID,
        }.to_account_metas(None),
        data: private_loan::instruction::RequestFirstScenario { client_seed: 1 }.data() };
    assert!(e.send(ix).is_err());
    assert_eq!(e.svm.get_account(&scenario).unwrap().data, bytes);
}
