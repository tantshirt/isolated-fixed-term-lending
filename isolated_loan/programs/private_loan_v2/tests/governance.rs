//! Governance rotation must revoke the operational AI worker atomically.
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use governance::Authorities;
use litesvm::LiteSVM;
use private_loan_v2::{ai::{layout, AiConfig, STATUS_PENDING, STATUS_PROCESSING}, config::Config};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const ID: Pubkey = private_loan_v2::ID;

fn put(svm: &mut LiteSVM, key: Pubkey, data: Vec<u8>) {
    svm.set_account(key, Account {
        lamports: svm.minimum_balance_for_rent_exemption(data.len()).max(1),
        data, owner: ID, executable: false, rent_epoch: 0,
    }).unwrap();
}

fn send(svm: &mut LiteSVM, signer: &Keypair, ix: Instruction) -> bool {
    let tx = Transaction::new(&[signer], Message::new(&[ix], Some(&signer.pubkey())), svm.latest_blockhash());
    svm.send_transaction(tx).is_ok()
}

#[test]
fn rotation_revokes_old_worker_and_preserves_enablement() {
    for enabled in [true, false] {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(ID, concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/private_loan_v2.so")).unwrap();
        let (gov, old, new) = (Keypair::new(), Keypair::new(), Keypair::new());
        for signer in [&gov, &old, &new] { svm.airdrop(&signer.pubkey(), 1_000_000_000).unwrap(); }
        let (config, bump) = Pubkey::find_program_address(&[b"config"], &ID);
        let (ai_config, ai_bump) = Pubkey::find_program_address(&[b"ai-config"], &ID);
        let authorities = Authorities {
            governance: gov.pubkey(), ai_admin: Pubkey::new_unique(), ai_worker: old.pubkey(),
            liquidation_pool_admin: Pubkey::new_unique(), credential_issuer: Pubkey::new_unique(), keeper: Pubkey::new_unique(),
        };
        let next = Authorities { ai_worker: new.pubkey(), ..authorities };
        let mut data = Vec::new();
        Config { version: 1, authorities, bump }.try_serialize(&mut data).unwrap();
        put(&mut svm, config, data);
        let mut data = Vec::new();
        AiConfig { worker: old.pubkey(), enabled, bump: ai_bump }.try_serialize(&mut data).unwrap();
        put(&mut svm, ai_config, data);
        let rotate = Instruction {
            program_id: ID,
            accounts: private_loan_v2::accounts::RotateAuthorities { governance: gov.pubkey(), config, ai_config }.to_account_metas(None),
            data: private_loan_v2::instruction::RotateAuthorities { next }.data(),
        };
        assert!(send(&mut svm, &gov, rotate));
        let data = svm.get_account(&ai_config).unwrap().data;
        let ai = AiConfig::try_deserialize(&mut &data[..]).unwrap();
        assert_eq!(ai.worker, new.pubkey(), "rotation must update the worker used by requests and callbacks");
        assert_eq!(ai.enabled, enabled, "rotation must not enable a disabled copilot");
        let request = Pubkey::new_unique();
        let mut data = vec![0; layout::LEN];
        data[0] = 1;
        data[layout::DEADLINE..layout::DEADLINE + 8].copy_from_slice(&i64::MAX.to_le_bytes());
        data[layout::STATUS] = STATUS_PENDING;
        put(&mut svm, request, data);
        let claim = |worker| Instruction {
            program_id: ID,
            accounts: private_loan_v2::accounts::ClaimAiRequest { worker, config: ai_config, request }.to_account_metas(None),
            data: private_loan_v2::instruction::ClaimAiRequest { claim_id: [1; 32] }.data(),
        };
        assert!(!send(&mut svm, &old, claim(old.pubkey())), "rotated worker must no longer claim requests");
        assert_eq!(send(&mut svm, &new, claim(new.pubkey())), enabled);
        assert_eq!(svm.get_account(&request).unwrap().data[layout::STATUS], if enabled { STATUS_PROCESSING } else { STATUS_PENDING });
    }
}

#[test]
fn rotation_before_ai_setup_requires_the_canonical_address() {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ID, concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/private_loan_v2.so")).unwrap();
    let gov = Keypair::new();
    svm.airdrop(&gov.pubkey(), 1_000_000_000).unwrap();
    let (config, bump) = Pubkey::find_program_address(&[b"config"], &ID);
    let ai_config = Pubkey::find_program_address(&[b"ai-config"], &ID).0;
    let authorities = Authorities {
        governance: gov.pubkey(), ai_admin: Pubkey::new_unique(), ai_worker: Pubkey::new_unique(),
        liquidation_pool_admin: Pubkey::new_unique(), credential_issuer: Pubkey::new_unique(), keeper: Pubkey::new_unique(),
    };
    let next = Authorities { ai_worker: Pubkey::new_unique(), ..authorities };
    let mut data = Vec::new();
    Config { version: 1, authorities, bump }.try_serialize(&mut data).unwrap();
    put(&mut svm, config, data);
    let rotate = |ai_config| Instruction {
        program_id: ID,
        accounts: private_loan_v2::accounts::RotateAuthorities { governance: gov.pubkey(), config, ai_config }.to_account_metas(None),
        data: private_loan_v2::instruction::RotateAuthorities { next }.data(),
    };
    assert!(!send(&mut svm, &gov, rotate(Pubkey::new_unique())));
    assert!(send(&mut svm, &gov, rotate(ai_config)));
    let data = svm.get_account(&config).unwrap().data;
    assert_eq!(Config::try_deserialize(&mut &data[..]).unwrap().authorities.ai_worker, next.ai_worker);
}
