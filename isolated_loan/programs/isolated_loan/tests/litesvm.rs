//! Instruction tests on LiteSVM. Run `anchor build` first so the .so is current.
//!
//! Token accounts are packed by hand so the tests stay on the same Solana 3.x types
//! as anchor-lang. The Pyth account is owned by the real receiver id: the owner
//! check in `oracle.rs` is exercised, never bypassed.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use isolated_loan::constants::{
    OFFER_SEED, PYTH_RECEIVER_PROGRAM_ID, REQUEST_SEED, REQUEST_WSOL_VAULT_SEED, SOL_USD_FEED_ID, USDC_VAULT_SEED,
    WSOL_VAULT_SEED,
};
use isolated_loan::error::LoanError;
use isolated_loan::state::{LoanRequest, Offer, OfferStatus, RequestStatus};
use litesvm::LiteSVM;
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

const START: i64 = 1_700_000_000;
const PRINCIPAL: u64 = 100_000_000; // 100 USDC
const INTEREST_BPS: u16 = 500; // 5%
const DEBT: u64 = 105_000_000;
const DURATION: i64 = 7 * 24 * 60 * 60;
const COLLATERAL: u64 = 1_001_001_002; // minimum wSOL at 149.85 conservative
const MAX_LTV: u16 = 7_000;
const LIQ_LTV: u16 = 8_000;

// $150.00 with 0.1% confidence, exponent -8.
const PRICE_OK: i64 = 15_000_000_000;
const CONF_OK: u64 = 15_000_000;

fn code(e: LoanError) -> String {
    format!("Custom({})", u32::from(e))
}

struct Env {
    svm: LiteSVM,
    lender: Keypair,
    borrower: Keypair,
    stranger: Keypair,
    usdc_mint: Pubkey,
    wsol_mint: Pubkey,
    price: Pubkey,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/isolated_loan.so");
        svm.add_program_from_file(isolated_loan::ID, so)
            .expect("run `anchor build` before the LiteSVM tests");

        let lender = Keypair::new();
        let borrower = Keypair::new();
        let stranger = Keypair::new();
        for k in [&lender, &borrower, &stranger] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }

        let mut env = Env {
            svm,
            lender,
            borrower,
            stranger,
            usdc_mint: Pubkey::new_unique(),
            wsol_mint: Pubkey::new_unique(),
            price: Pubkey::new_unique(),
        };
        env.set_time(START);
        env.put_mint(env.usdc_mint, 6);
        env.put_mint(env.wsol_mint, 9);

        let (l, b, s) = (env.lender.pubkey(), env.borrower.pubkey(), env.stranger.pubkey());
        env.put_ata(env.usdc_mint, l, 1_000_000_000);
        env.put_ata(env.wsol_mint, l, 0);
        env.put_ata(env.usdc_mint, b, 1_000_000_000);
        env.put_ata(env.wsol_mint, b, 10_000_000_000);
        env.put_ata(env.usdc_mint, s, 1_000_000_000);
        env.put_ata(env.wsol_mint, s, 0);
        env.post_price(PRICE_OK, CONF_OK, START, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
        env
    }

    fn set_time(&mut self, ts: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = ts;
        self.svm.set_sysvar(&clock);
    }

    fn put_mint(&mut self, mint: Pubkey, decimals: u8) {
        let mut data = vec![0u8; 82];
        data[44] = decimals;
        data[45] = 1; // is_initialized
        self.put(mint, TOKEN_PROGRAM, data);
    }

    fn put_ata(&mut self, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
        let ata = ata(owner, mint);
        let mut data = vec![0u8; 165];
        data[0..32].copy_from_slice(mint.as_ref());
        data[32..64].copy_from_slice(owner.as_ref());
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        data[108] = 1; // AccountState::Initialized
        self.put(ata, TOKEN_PROGRAM, data);
        ata
    }

    fn put(&mut self, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(key, Account { lamports, data, owner, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    fn post_price(&mut self, price: i64, conf: u64, publish_time: i64, feed_id: [u8; 32], owner: Pubkey) {
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
                ema_price: price,
                ema_conf: conf,
            },
            posted_slot: 1,
        };
        let mut data = Vec::with_capacity(PriceUpdateV2::LEN);
        update.try_serialize(&mut data).unwrap();
        self.put(self.price, owner, data);
    }

    fn balance(&self, token_account: Pubkey) -> u64 {
        match self.svm.get_account(&token_account) {
            Some(a) => u64::from_le_bytes(a.data[64..72].try_into().unwrap()),
            None => 0,
        }
    }

    fn lamports(&self, key: Pubkey) -> u64 {
        self.svm.get_account(&key).map(|a| a.lamports).unwrap_or(0)
    }

    fn exists(&self, key: Pubkey) -> bool {
        self.svm.get_account(&key).map(|a| a.lamports > 0).unwrap_or(false)
    }

    fn offer(&self, key: Pubkey) -> Offer {
        let a = self.svm.get_account(&key).expect("offer exists");
        Offer::try_deserialize(&mut &a.data[..]).unwrap()
    }

    fn request(&self, key: Pubkey) -> LoanRequest {
        let a = self.svm.get_account(&key).expect("request exists");
        LoanRequest::try_deserialize(&mut &a.data[..]).unwrap()
    }

    fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), String> {
        self.svm.expire_blockhash();
        let msg = Message::new(&[ix], Some(&signer.pubkey()));
        let tx = Transaction::new(&[signer], msg, self.svm.latest_blockhash());
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs))
    }

    // ---- instruction builders ----

    fn create(&mut self, offer_id: u64) -> Result<Pubkey, String> {
        let lender = self.lender.insecure_clone();
        self.create_with(&lender, offer_id, self.usdc_mint, self.wsol_mint).map(|(o, _)| o)
    }

    fn create_with(&mut self, lender: &Keypair, offer_id: u64, usdc: Pubkey, wsol: Pubkey) -> Result<(Pubkey, Pubkey), String> {
        let offer = offer_pda(lender.pubkey(), offer_id);
        let vault = pda(&[USDC_VAULT_SEED, offer.as_ref()]);
        let ix = Instruction {
            program_id: isolated_loan::ID,
            accounts: isolated_loan::accounts::CreateOffer {
                lender: lender.pubkey(),
                offer,
                usdc_mint: usdc,
                wsol_mint: wsol,
                usdc_vault: vault,
                lender_usdc: ata(lender.pubkey(), usdc),
                token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan::instruction::CreateOffer {
                offer_id,
                principal: PRINCIPAL,
                interest_bps: INTEREST_BPS,
                duration_seconds: DURATION,
                collateral_amount: COLLATERAL,
                max_ltv_bps: MAX_LTV,
                liquidation_ltv_bps: LIQ_LTV,
            }
            .data(),
        };
        self.send(ix, lender).map(|_| (offer, vault))
    }

    fn cancel(&mut self, offer: Pubkey, signer: &Keypair) -> Result<(), String> {
        let ix = Instruction {
            program_id: isolated_loan::ID,
            accounts: isolated_loan::accounts::CancelOffer {
                lender: signer.pubkey(),
                offer,
                usdc_vault: pda(&[USDC_VAULT_SEED, offer.as_ref()]),
                lender_usdc: ata(signer.pubkey(), self.usdc_mint),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan::instruction::CancelOffer {}.data(),
        };
        self.send(ix, signer)
    }

    fn accept(&mut self, offer: Pubkey) -> Result<(), String> {
        let b = self.borrower.insecure_clone();
        let ix = Instruction {
            program_id: isolated_loan::ID,
            accounts: isolated_loan::accounts::AcceptOffer {
                borrower: b.pubkey(),
                offer,
                lender: self.lender.pubkey(),
                price_update: self.price,
                usdc_vault: pda(&[USDC_VAULT_SEED, offer.as_ref()]),
                wsol_mint: self.wsol_mint,
                wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
                borrower_usdc: ata(b.pubkey(), self.usdc_mint),
                borrower_wsol: ata(b.pubkey(), self.wsol_mint),
                token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan::instruction::AcceptOffer {}.data(),
        };
        self.send(ix, &b)
    }

    fn repay(&mut self, offer: Pubkey) -> Result<(), String> {
        let b = self.borrower.insecure_clone();
        let ix = Instruction {
            program_id: isolated_loan::ID,
            accounts: isolated_loan::accounts::RepayLoan {
                borrower: b.pubkey(),
                offer,
                wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
                borrower_usdc: ata(b.pubkey(), self.usdc_mint),
                lender: self.lender.pubkey(),
                lender_usdc: ata(self.lender.pubkey(), self.usdc_mint),
                borrower_wsol: ata(b.pubkey(), self.wsol_mint),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan::instruction::RepayLoan {}.data(),
        };
        self.send(ix, &b)
    }

    fn claim(&mut self, offer: Pubkey) -> Result<(), String> {
        let s = self.stranger.insecure_clone();
        let ix = Instruction {
            program_id: isolated_loan::ID,
            accounts: isolated_loan::accounts::ClaimExpiredLoan {
                caller: s.pubkey(),
                offer,
                wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
                lender: self.lender.pubkey(),
                lender_wsol: ata(self.lender.pubkey(), self.wsol_mint),
                borrower: self.borrower.pubkey(),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan::instruction::ClaimExpiredLoan {}.data(),
        };
        self.send(ix, &s)
    }

    fn liquidate(&mut self, offer: Pubkey, caller: &Keypair) -> Result<(), String> {
        let ix = Instruction {
            program_id: isolated_loan::ID,
            accounts: isolated_loan::accounts::LiquidateLoan {
                caller: caller.pubkey(),
                offer,
                price_update: self.price,
                wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
                caller_usdc: ata(caller.pubkey(), self.usdc_mint),
                lender: self.lender.pubkey(),
                lender_usdc: ata(self.lender.pubkey(), self.usdc_mint),
                borrower: self.borrower.pubkey(),
                borrower_wsol: ata(self.borrower.pubkey(), self.wsol_mint),
                caller_wsol: ata(caller.pubkey(), self.wsol_mint),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan::instruction::LiquidateLoan {}.data(),
        };
        self.send(ix, caller)
    }

    fn close(&mut self, offer: Pubkey, signer: &Keypair) -> Result<(), String> {
        let ix = Instruction {
            program_id: isolated_loan::ID,
            accounts: isolated_loan::accounts::CloseOffer { lender: signer.pubkey(), offer }
                .to_account_metas(None),
            data: isolated_loan::instruction::CloseOffer {}.data(),
        };
        self.send(ix, signer)
    }

    fn create_request(&mut self, request_id: u64) -> Result<Pubkey, String> {
        let b = self.borrower.insecure_clone();
        self.create_request_with(&b, request_id, self.usdc_mint, self.wsol_mint, MAX_LTV)
    }

    fn create_request_with(
        &mut self,
        borrower: &Keypair,
        request_id: u64,
        usdc: Pubkey,
        wsol: Pubkey,
        max_ltv: u16,
    ) -> Result<Pubkey, String> {
        let request = request_pda(borrower.pubkey(), request_id);
        let ix = Instruction {
            program_id: isolated_loan::ID,
            accounts: isolated_loan::accounts::CreateRequest {
                borrower: borrower.pubkey(),
                request,
                usdc_mint: usdc,
                wsol_mint: wsol,
                request_vault: pda(&[REQUEST_WSOL_VAULT_SEED, request.as_ref()]),
                borrower_wsol: ata(borrower.pubkey(), wsol),
                borrower_usdc: ata(borrower.pubkey(), usdc),
                token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan::instruction::CreateRequest {
                request_id,
                principal: PRINCIPAL,
                interest_bps: INTEREST_BPS,
                duration_seconds: DURATION,
                collateral_amount: COLLATERAL,
                max_ltv_bps: max_ltv,
                liquidation_ltv_bps: LIQ_LTV,
            }
            .data(),
        };
        self.send(ix, borrower).map(|_| request)
    }

    fn cancel_request(&mut self, request: Pubkey, signer: &Keypair) -> Result<(), String> {
        let ix = Instruction {
            program_id: isolated_loan::ID,
            accounts: isolated_loan::accounts::CancelRequest {
                borrower: signer.pubkey(),
                request,
                request_vault: pda(&[REQUEST_WSOL_VAULT_SEED, request.as_ref()]),
                borrower_wsol: ata(signer.pubkey(), self.wsol_mint),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan::instruction::CancelRequest {}.data(),
        };
        self.send(ix, signer)
    }

    /// Funds `request` as `lender`, creating offer `offer_id`. Returns the offer.
    fn fund_request(&mut self, request: Pubkey, lender: &Keypair, offer_id: u64) -> Result<Pubkey, String> {
        let offer = offer_pda(lender.pubkey(), offer_id);
        let borrower = self.borrower.pubkey();
        let ix = Instruction {
            program_id: isolated_loan::ID,
            accounts: isolated_loan::accounts::FundRequest {
                lender: lender.pubkey(),
                request,
                borrower,
                price_update: self.price,
                offer,
                wsol_mint: self.wsol_mint,
                request_vault: pda(&[REQUEST_WSOL_VAULT_SEED, request.as_ref()]),
                wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
                lender_usdc: ata(lender.pubkey(), self.usdc_mint),
                borrower_usdc: ata(borrower, self.usdc_mint),
                token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: isolated_loan::instruction::FundRequest { offer_id }.data(),
        };
        self.send(ix, lender).map(|_| offer)
    }

    fn close_request(&mut self, request: Pubkey, signer: &Keypair) -> Result<(), String> {
        let ix = Instruction {
            program_id: isolated_loan::ID,
            accounts: isolated_loan::accounts::CloseRequest { borrower: signer.pubkey(), request }
                .to_account_metas(None),
            data: isolated_loan::instruction::CloseRequest {}.data(),
        };
        self.send(ix, signer)
    }

    /// A request funded by the default lender: an ordinary filled offer.
    fn funded_request(&mut self, id: u64) -> Pubkey {
        let request = self.create_request(id).unwrap();
        let lender = self.lender.insecure_clone();
        self.fund_request(request, &lender, id).unwrap()
    }

    fn filled_offer(&mut self, offer_id: u64) -> Pubkey {
        let offer = self.create(offer_id).unwrap();
        self.accept(offer).unwrap();
        offer
    }
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &isolated_loan::ID).0
}

fn offer_pda(lender: Pubkey, id: u64) -> Pubkey {
    pda(&[OFFER_SEED, lender.as_ref(), &id.to_le_bytes()])
}

fn request_pda(borrower: Pubkey, id: u64) -> Pubkey {
    pda(&[REQUEST_SEED, borrower.as_ref(), &id.to_le_bytes()])
}

fn ata(owner: Pubkey, mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

fn assert_err(r: Result<(), String>, e: LoanError) {
    let msg = r.expect_err("expected the instruction to fail");
    assert!(msg.contains(&code(e)), "expected {}, got {msg}", code(e));
}

// ---------------------------------------------------------------------------

#[test]
fn create_and_cancel() {
    let mut env = Env::new();
    let lender_usdc = ata(env.lender.pubkey(), env.usdc_mint);
    let offer = env.create(1).unwrap();
    let vault = pda(&[USDC_VAULT_SEED, offer.as_ref()]);
    assert_eq!(env.balance(vault), PRINCIPAL);
    assert_eq!(env.balance(lender_usdc), 1_000_000_000 - PRINCIPAL);

    let stranger = env.stranger.insecure_clone();
    assert!(env.cancel(offer, &stranger).is_err(), "a stranger cannot cancel");

    let lender = env.lender.insecure_clone();
    env.cancel(offer, &lender).unwrap();
    assert_eq!(env.balance(lender_usdc), 1_000_000_000);
    assert!(!env.exists(vault), "vault is closed");
    assert!(env.offer(offer).status == OfferStatus::Cancelled);
    assert!(env.cancel(offer, &lender).is_err(), "second cancel fails");
}

#[test]
fn mint_guards() {
    let mut env = Env::new();
    let lender = env.lender.insecure_clone();
    let bad_usdc = Pubkey::new_unique();
    env.put_mint(bad_usdc, 9);
    env.put_ata(bad_usdc, lender.pubkey(), 1_000_000_000);
    assert_err(env.create_with(&lender, 1, bad_usdc, env.wsol_mint).map(|_| ()), LoanError::InvalidUsdcMint);

    let bad_wsol = Pubkey::new_unique();
    env.put_mint(bad_wsol, 6);
    assert_err(env.create_with(&lender, 2, env.usdc_mint, bad_wsol).map(|_| ()), LoanError::InvalidWsolMint);

    // Same mint for both legs: give it 6 decimals so only the equality guard trips.
    let usdc = env.usdc_mint;
    let r = env.create_with(&lender, 3, usdc, usdc).map(|_| ());
    let msg = r.expect_err("same mint must fail");
    assert!(
        msg.contains(&code(LoanError::SameMint)) || msg.contains(&code(LoanError::InvalidWsolMint)),
        "{msg}"
    );
}

#[test]
fn accept_moves_funds_and_returns_vault_rent_to_lender() {
    let mut env = Env::new();
    let offer = env.create(1).unwrap();
    let usdc_vault = pda(&[USDC_VAULT_SEED, offer.as_ref()]);
    let wsol_vault = pda(&[WSOL_VAULT_SEED, offer.as_ref()]);
    let vault_rent = env.lamports(usdc_vault);
    let lender_before = env.lamports(env.lender.pubkey());
    let b_usdc = ata(env.borrower.pubkey(), env.usdc_mint);
    let b_wsol = ata(env.borrower.pubkey(), env.wsol_mint);

    env.accept(offer).unwrap();

    assert_eq!(env.balance(b_usdc), 1_000_000_000 + PRINCIPAL);
    assert_eq!(env.balance(b_wsol), 10_000_000_000 - COLLATERAL);
    assert_eq!(env.balance(wsol_vault), COLLATERAL);
    assert!(!env.exists(usdc_vault));
    assert_eq!(env.lamports(env.lender.pubkey()), lender_before + vault_rent, "lender gets the USDC vault rent back");
    let o = env.offer(offer);
    assert!(o.status == OfferStatus::Filled);
    assert_eq!(o.expiry_ts, START + DURATION);
}

#[test]
fn accept_rejects_price_that_fails_ltv_cap() {
    let mut env = Env::new();
    let offer = env.create(1).unwrap();
    // $140: collateral is worth ~140 USDC, debt 105 → 75% > 70%.
    env.post_price(14_000_000_000, 14_000_000, START, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
    assert_err(env.accept(offer), LoanError::InsufficientCollateral);
}

#[test]
fn accept_rejects_bad_oracle() {
    let mut env = Env::new();
    let offer = env.create(1).unwrap();

    env.post_price(PRICE_OK, CONF_OK, START, SOL_USD_FEED_ID, Pubkey::new_unique());
    assert_err(env.accept(offer), LoanError::InvalidPriceOwner);

    env.post_price(PRICE_OK, CONF_OK, START, [7u8; 32], PYTH_RECEIVER_PROGRAM_ID);
    assert_err(env.accept(offer), LoanError::InvalidFeedId);

    env.post_price(PRICE_OK, CONF_OK, START - 61, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
    assert_err(env.accept(offer), LoanError::StalePrice);

    // Confidence 3% of price.
    env.post_price(PRICE_OK, 450_000_000, START, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
    assert_err(env.accept(offer), LoanError::InvalidPrice);
}

#[test]
fn repay_and_claim_deadlines() {
    // Repay before the deadline.
    let mut env = Env::new();
    let offer = env.filled_offer(1);
    let lender_usdc = ata(env.lender.pubkey(), env.usdc_mint);
    let b_wsol = ata(env.borrower.pubkey(), env.wsol_mint);
    let wsol_vault = pda(&[WSOL_VAULT_SEED, offer.as_ref()]);
    let lender_before = env.balance(lender_usdc);
    env.set_time(START + DURATION - 1);
    env.repay(offer).unwrap();
    assert_eq!(env.balance(lender_usdc), lender_before + DEBT);
    assert_eq!(env.balance(b_wsol), 10_000_000_000);
    assert!(!env.exists(wsol_vault));
    assert!(env.offer(offer).status == OfferStatus::Repaid);

    // Repay at expiry fails; claim one second early fails; claim at expiry works.
    let mut env = Env::new();
    let offer = env.filled_offer(2);
    let wsol_vault = pda(&[WSOL_VAULT_SEED, offer.as_ref()]);
    let vault_rent = env.lamports(wsol_vault);
    env.set_time(START + DURATION);
    assert_err(env.repay(offer), LoanError::LoanExpired);
    // Measured after the failed repay, which still charged the borrower a fee.
    let borrower_before = env.lamports(env.borrower.pubkey());
    env.set_time(START + DURATION - 1);
    assert_err(env.claim(offer), LoanError::LoanNotExpired);
    env.set_time(START + DURATION);
    env.claim(offer).unwrap();
    assert_eq!(env.balance(ata(env.lender.pubkey(), env.wsol_mint)), COLLATERAL);
    assert!(!env.exists(wsol_vault));
    assert_eq!(env.lamports(env.borrower.pubkey()), borrower_before + vault_rent, "borrower gets the wSOL vault rent back");
    assert!(env.offer(offer).status == OfferStatus::Expired);

    // Liquidate after expiry is not allowed either.
    let mut env = Env::new();
    let offer = env.filled_offer(3);
    env.set_time(START + DURATION);
    env.post_price(1_000_000_000, 1_000_000, START + DURATION, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
    let s = env.stranger.insecure_clone();
    assert_err(env.liquidate(offer, &s), LoanError::LoanExpired);
}

#[test]
fn liquidation_rules() {
    let mut env = Env::new();
    let offer = env.filled_offer(1);
    let s = env.stranger.insecure_clone();
    let b = env.borrower.insecure_clone();

    assert_err(env.liquidate(offer, &s), LoanError::LoanHealthy);

    // $120 crosses 80%.
    env.post_price(12_000_000_000, 12_000_000, START, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
    // With the borrower's own ATAs Anchor rejects the duplicate account first;
    // either way the borrower cannot liquidate.
    let msg = env.liquidate(offer, &b).expect_err("borrower cannot liquidate");
    assert!(msg.contains(&code(LoanError::BorrowerCannotLiquidate)) || msg.contains("Custom(2040)"), "{msg}");

    env.post_price(12_000_000_000, 12_000_000, START - 61, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
    assert_err(env.liquidate(offer, &s), LoanError::StalePrice);

    env.post_price(12_000_000_000, 12_000_000, START, [9u8; 32], PYTH_RECEIVER_PROGRAM_ID);
    assert_err(env.liquidate(offer, &s), LoanError::InvalidFeedId);

    env.post_price(12_000_000_000, 12_000_000, START, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
    let wsol_vault = pda(&[WSOL_VAULT_SEED, offer.as_ref()]);
    let vault_rent = env.lamports(wsol_vault);
    let borrower_before = env.lamports(env.borrower.pubkey());
    let lender_usdc = ata(env.lender.pubkey(), env.usdc_mint);
    let lender_before = env.balance(lender_usdc);
    env.liquidate(offer, &s).unwrap();

    assert_eq!(env.balance(lender_usdc), lender_before + DEBT);
    let to_caller = env.balance(ata(s.pubkey(), env.wsol_mint));
    let to_borrower = env.balance(ata(b.pubkey(), env.wsol_mint)) - (10_000_000_000 - COLLATERAL);
    assert_eq!(to_caller + to_borrower, COLLATERAL);
    // value 120.00 USDC, seize 110.25 → ceil(1_001_001_002 * 110.25 / 120.00)
    assert_eq!(to_caller, 919_669_671);
    assert!(!env.exists(wsol_vault));
    assert_eq!(env.lamports(env.borrower.pubkey()), borrower_before + vault_rent);
    assert!(env.offer(offer).status == OfferStatus::Liquidated);
}

#[test]
fn deep_underwater_loan_can_still_be_liquidated() {
    let mut env = Env::new();
    let offer = env.filled_offer(1);
    // $5: collateral ~5 USDC, LTV ~210_000 bps, above u16::MAX.
    env.post_price(500_000_000, 500_000, START, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
    let s = env.stranger.insecure_clone();
    env.liquidate(offer, &s).unwrap();
    assert_eq!(env.balance(ata(s.pubkey(), env.wsol_mint)), COLLATERAL, "caller takes all collateral");
}

#[test]
fn no_second_settlement_and_close() {
    let lender_of = |env: &Env| env.lender.insecure_clone();
    let s_of = |env: &Env| env.stranger.insecure_clone();

    for ending in ["repay", "claim", "liquidate"] {
        let mut env = Env::new();
        let offer = env.filled_offer(1);
        let s = s_of(&env);
        let lender = lender_of(&env);

        assert_err(env.close(offer, &lender), LoanError::OfferNotSettled);

        match ending {
            "repay" => env.repay(offer).unwrap(),
            "claim" => {
                env.set_time(START + DURATION);
                env.claim(offer).unwrap()
            }
            _ => {
                env.post_price(12_000_000_000, 12_000_000, START, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
                env.liquidate(offer, &s).unwrap()
            }
        }

        // Every settlement instruction now fails. The vault is gone, so Anchor may
        // reject the missing account before the status check: any failure is correct.
        assert!(env.repay(offer).is_err(), "{ending}: repay again");
        env.set_time(START + DURATION);
        assert!(env.claim(offer).is_err(), "{ending}: claim again");
        env.set_time(START);
        env.post_price(12_000_000_000, 12_000_000, START, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
        assert!(env.liquidate(offer, &s).is_err(), "{ending}: liquidate again");
        assert!(env.accept(offer).is_err(), "{ending}: accept again");

        assert!(env.close(offer, &s).is_err(), "{ending}: stranger cannot close");
        let before = env.lamports(lender.pubkey());
        let offer_rent = env.lamports(offer);
        env.close(offer, &lender).unwrap();
        assert!(!env.exists(offer), "{ending}: offer closed");
        assert_eq!(env.lamports(lender.pubkey()), before + offer_rent - 5_000, "{ending}: rent minus fee");
    }
}

// ---- borrower requests --------------------------------------------------------

#[test]
fn request_create_and_cancel() {
    let mut env = Env::new();
    let b_wsol = ata(env.borrower.pubkey(), env.wsol_mint);
    let request = env.create_request(1).unwrap();
    let vault = pda(&[REQUEST_WSOL_VAULT_SEED, request.as_ref()]);
    assert_eq!(env.balance(vault), COLLATERAL);
    assert_eq!(env.balance(b_wsol), 10_000_000_000 - COLLATERAL);
    let r = env.request(request);
    assert!(r.status == RequestStatus::Open);
    assert_eq!(r.created_ts, START);
    assert_eq!(r.lender, Pubkey::default());

    let s = env.stranger.insecure_clone();
    assert!(env.cancel_request(request, &s).is_err(), "a stranger cannot cancel");

    let b = env.borrower.insecure_clone();
    let vault_rent = env.lamports(vault);
    let before = env.lamports(b.pubkey());
    env.cancel_request(request, &b).unwrap();
    assert_eq!(env.balance(b_wsol), 10_000_000_000);
    assert!(!env.exists(vault), "vault is closed");
    assert_eq!(env.lamports(b.pubkey()), before + vault_rent - 5_000, "vault rent back minus fee");
    assert!(env.request(request).status == RequestStatus::Cancelled);
    // The vault is gone, so Anchor rejects the missing account before the status check.
    assert!(env.cancel_request(request, &b).is_err(), "second cancel fails");
}

#[test]
fn request_terms_and_mint_guards() {
    let mut env = Env::new();
    let b = env.borrower.insecure_clone();
    // Max LTV above the liquidation LTV is outside the caps.
    assert_err(
        env.create_request_with(&b, 1, env.usdc_mint, env.wsol_mint, LIQ_LTV + 1).map(|_| ()),
        LoanError::InvalidTerms,
    );

    let bad_usdc = Pubkey::new_unique();
    env.put_mint(bad_usdc, 9);
    env.put_ata(bad_usdc, b.pubkey(), 0);
    assert_err(
        env.create_request_with(&b, 2, bad_usdc, env.wsol_mint, MAX_LTV).map(|_| ()),
        LoanError::InvalidUsdcMint,
    );

    let bad_wsol = Pubkey::new_unique();
    env.put_mint(bad_wsol, 6);
    env.put_ata(bad_wsol, b.pubkey(), COLLATERAL);
    assert_err(
        env.create_request_with(&b, 3, env.usdc_mint, bad_wsol, MAX_LTV).map(|_| ()),
        LoanError::InvalidWsolMint,
    );

    // Without a USDC account the request is refused, so funding never has to create one.
    let fresh = Keypair::new();
    env.svm.airdrop(&fresh.pubkey(), 1_000_000_000).unwrap();
    env.put_ata(env.wsol_mint, fresh.pubkey(), COLLATERAL);
    assert!(env.create_request_with(&fresh, 4, env.usdc_mint, env.wsol_mint, MAX_LTV).is_err());
}

#[test]
fn fund_request_moves_funds_and_is_rent_neutral() {
    let mut env = Env::new();
    let request = env.create_request(1).unwrap();
    let request_vault = pda(&[REQUEST_WSOL_VAULT_SEED, request.as_ref()]);
    let request_vault_rent = env.lamports(request_vault);
    let lender = env.lender.insecure_clone();
    let l_usdc = ata(lender.pubkey(), env.usdc_mint);
    let b_usdc = ata(env.borrower.pubkey(), env.usdc_mint);
    let lender_before = env.lamports(lender.pubkey());

    let offer = env.fund_request(request, &lender, 7).unwrap();
    let wsol_vault = pda(&[WSOL_VAULT_SEED, offer.as_ref()]);

    assert_eq!(env.balance(b_usdc), 1_000_000_000 + PRINCIPAL);
    assert_eq!(env.balance(l_usdc), 1_000_000_000 - PRINCIPAL);
    assert_eq!(env.balance(wsol_vault), COLLATERAL);
    assert!(!env.exists(request_vault), "request vault is closed");
    // Same-size vaults: the lender pays the offer and its vault, gets the request vault back.
    assert_eq!(env.lamports(wsol_vault), request_vault_rent);
    assert_eq!(
        env.lamports(lender.pubkey()),
        lender_before - env.lamports(offer) - 5_000,
        "lender's only lasting cost is the offer rent, refunded by close_offer"
    );

    let o = env.offer(offer);
    assert!(o.status == OfferStatus::Filled);
    assert_eq!(o.lender, lender.pubkey());
    assert_eq!(o.borrower, env.borrower.pubkey());
    assert_eq!(o.offer_id, 7);
    assert_eq!(o.principal, PRINCIPAL);
    assert_eq!(o.interest_bps, INTEREST_BPS);
    assert_eq!(o.collateral_amount, COLLATERAL);
    assert_eq!(o.max_ltv_bps, MAX_LTV);
    assert_eq!(o.liquidation_ltv_bps, LIQ_LTV);
    assert_eq!(o.start_ts, START);
    assert_eq!(o.expiry_ts, START + DURATION);

    let r = env.request(request);
    assert!(r.status == RequestStatus::Funded);
    assert_eq!(r.lender, lender.pubkey());
    assert_eq!(r.offer, offer);
}

#[test]
fn fund_request_rejections() {
    let mut env = Env::new();
    let request = env.create_request(1).unwrap();
    let lender = env.lender.insecure_clone();

    // $140 fails the 70% cap, as in accept.
    env.post_price(14_000_000_000, 14_000_000, START, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
    assert_err(env.fund_request(request, &lender, 1).map(|_| ()), LoanError::InsufficientCollateral);

    env.post_price(PRICE_OK, CONF_OK, START, SOL_USD_FEED_ID, Pubkey::new_unique());
    assert_err(env.fund_request(request, &lender, 1).map(|_| ()), LoanError::InvalidPriceOwner);

    env.post_price(PRICE_OK, CONF_OK, START, [7u8; 32], PYTH_RECEIVER_PROGRAM_ID);
    assert_err(env.fund_request(request, &lender, 1).map(|_| ()), LoanError::InvalidFeedId);

    env.post_price(PRICE_OK, CONF_OK, START - 61, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
    assert_err(env.fund_request(request, &lender, 1).map(|_| ()), LoanError::StalePrice);

    env.post_price(PRICE_OK, CONF_OK, START, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
    let b = env.borrower.insecure_clone();
    // With the borrower's own USDC account on both sides Anchor rejects the duplicate
    // first; either way the borrower cannot fund their own request.
    let msg = env.fund_request(request, &b, 1).expect_err("borrower cannot fund");
    assert!(msg.contains(&code(LoanError::SameBorrowerAndLender)) || msg.contains("Custom(2040)"), "{msg}");

    // A lender paying from an account of another mint is refused.
    let other = Pubkey::new_unique();
    env.put_mint(other, 6);
    let s = env.stranger.insecure_clone();
    let fake = env.put_ata(other, s.pubkey(), 1_000_000_000);
    let offer = offer_pda(s.pubkey(), 1);
    let ix = Instruction {
        program_id: isolated_loan::ID,
        accounts: isolated_loan::accounts::FundRequest {
            lender: s.pubkey(),
            request,
            borrower: b.pubkey(),
            price_update: env.price,
            offer,
            wsol_mint: env.wsol_mint,
            request_vault: pda(&[REQUEST_WSOL_VAULT_SEED, request.as_ref()]),
            wsol_vault: pda(&[WSOL_VAULT_SEED, offer.as_ref()]),
            lender_usdc: fake,
            borrower_usdc: ata(b.pubkey(), env.usdc_mint),
            token_program: TOKEN_PROGRAM,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM_PROGRAM,
        }
        .to_account_metas(None),
        data: isolated_loan::instruction::FundRequest { offer_id: 1 }.data(),
    };
    assert!(env.send(ix, &s).is_err(), "wrong USDC mint");

    env.fund_request(request, &lender, 1).unwrap();
    // The request vault closed at funding, so Anchor may reject the missing account
    // before the status check: any failure is correct.
    assert!(env.fund_request(request, &s, 2).is_err(), "funding twice");
    assert!(env.cancel_request(request, &b).is_err(), "cancel after funding");
    assert!(env.request(request).status == RequestStatus::Funded);

    let cancelled = env.create_request(2).unwrap();
    env.cancel_request(cancelled, &b).unwrap();
    // The vault is gone, so Anchor may fail on the missing account first: any failure is correct.
    assert!(env.fund_request(cancelled, &lender, 3).is_err(), "funding after cancel");
}

#[test]
fn funded_request_settles_through_existing_paths() {
    // Repay.
    let mut env = Env::new();
    let offer = env.funded_request(1);
    let lender_usdc = ata(env.lender.pubkey(), env.usdc_mint);
    let before = env.balance(lender_usdc);
    env.repay(offer).unwrap();
    assert_eq!(env.balance(lender_usdc), before + DEBT);
    assert_eq!(env.balance(ata(env.borrower.pubkey(), env.wsol_mint)), 10_000_000_000);
    assert!(env.offer(offer).status == OfferStatus::Repaid);
    let lender = env.lender.insecure_clone();
    env.close(offer, &lender).unwrap();

    // Claim at the expiry boundary, with the vault rent going to the borrower.
    let mut env = Env::new();
    let offer = env.funded_request(1);
    let wsol_vault = pda(&[WSOL_VAULT_SEED, offer.as_ref()]);
    let vault_rent = env.lamports(wsol_vault);
    let borrower_before = env.lamports(env.borrower.pubkey());
    env.set_time(START + DURATION - 1);
    assert_err(env.claim(offer), LoanError::LoanNotExpired);
    env.set_time(START + DURATION);
    env.claim(offer).unwrap();
    assert_eq!(env.balance(ata(env.lender.pubkey(), env.wsol_mint)), COLLATERAL);
    assert_eq!(env.lamports(env.borrower.pubkey()), borrower_before + vault_rent);
    assert!(env.offer(offer).status == OfferStatus::Expired);

    // Liquidate at $120.
    let mut env = Env::new();
    let offer = env.funded_request(1);
    env.post_price(12_000_000_000, 12_000_000, START, SOL_USD_FEED_ID, PYTH_RECEIVER_PROGRAM_ID);
    let s = env.stranger.insecure_clone();
    env.liquidate(offer, &s).unwrap();
    assert_eq!(env.balance(ata(s.pubkey(), env.wsol_mint)), 919_669_671);
    assert!(env.offer(offer).status == OfferStatus::Liquidated);
}

#[test]
fn close_request_rules() {
    let mut env = Env::new();
    let b = env.borrower.insecure_clone();
    let s = env.stranger.insecure_clone();
    let lender = env.lender.insecure_clone();

    let open = env.create_request(1).unwrap();
    assert_err(env.close_request(open, &b), LoanError::RequestNotSettled);

    env.fund_request(open, &lender, 1).unwrap();
    assert!(env.close_request(open, &s).is_err(), "stranger cannot close");
    let before = env.lamports(b.pubkey());
    let rent = env.lamports(open);
    env.close_request(open, &b).unwrap();
    assert!(!env.exists(open));
    assert_eq!(env.lamports(b.pubkey()), before + rent - 5_000);

    let cancelled = env.create_request(2).unwrap();
    env.cancel_request(cancelled, &b).unwrap();
    env.close_request(cancelled, &b).unwrap();
    assert!(!env.exists(cancelled));
}
