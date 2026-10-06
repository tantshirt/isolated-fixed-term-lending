//! Stateful fuzz of the public loan program on LiteSVM (audit phase 4, story 7.2).
//!
//! Each case runs a random sequence of every instruction, by random callers, with
//! random terms, prices, confidence, price age and clock jumps. After every step:
//!
//! 1. Token conservation: USDC and wSOL across wallets and vaults never change in total.
//! 2. Vaults match state: an open offer holds its principal, a filled loan its
//!    collateral, an open request its collateral; settled loans hold nothing.
//! 3. Status only moves forward, and a settled loan never moves again.
//! 4. A step that succeeds moves exactly the amounts its rule says, and only when
//!    its rule allows it (signer, deadline, LTV, price). A step that fails moves nothing.
//! 5. Liveness: repay before expiry, claim after expiry, cancel while open, and a
//!    valid liquidation always succeed, so funds are never stuck.
//!
//! Cases: FUZZ_CASES (default 2000). Run `anchor build` first.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use isolated_loan::constants::{
    OFFER_SEED, PYTH_RECEIVER_PROGRAM_ID, REQUEST_SEED, REQUEST_WSOL_VAULT_SEED, SOL_USD_FEED_ID, USDC_VAULT_SEED,
    WSOL_VAULT_SEED,
};
use isolated_loan::state::{LoanRequest, Offer, OfferStatus, RequestStatus};
use litesvm::LiteSVM;
use loan_core::constants::{USDC_MINT, WSOL_MINT};
use loan_core::math;
use proptest::prelude::*;
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
use solana_account::Account;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::sync::atomic::{AtomicU64, Ordering};

const TOKEN: Pubkey = anchor_spl::token::ID;
const ATA: Pubkey = anchor_spl::associated_token::ID;
const SYSTEM: Pubkey = anchor_lang::system_program::ID;
const START: i64 = 1_700_000_000;
const USERS: usize = 3;
const USDC_EACH: u64 = 1_000_000_000_000; // 1M USDC
const WSOL_EACH: u64 = 10_000_000_000_000; // 10k SOL

#[derive(Debug, Clone)]
struct Terms {
    principal: u64,
    interest_bps: u16,
    duration: i64,
    collateral: u64,
    max_ltv: u16,
    liq_ltv: u16,
}

#[derive(Debug, Clone)]
enum Op {
    CreateOffer { who: usize, t: Terms },
    CreateRequest { who: usize, t: Terms },
    Accept { loan: usize, who: usize },
    Fund { loan: usize, who: usize },
    CancelOffer { loan: usize, who: usize },
    CancelRequest { loan: usize, who: usize },
    Repay { loan: usize, who: usize },
    Claim { loan: usize, who: usize },
    Liquidate { loan: usize, who: usize },
    Close { loan: usize, who: usize },
    CloseRequest { loan: usize, who: usize },
    Price { cents: u64, conf_bps: u64, age: i64 },
    Warp { secs: i64, refresh: bool },
}

/// Collateral is mostly sized to land near the LTV caps at $150, so accepts,
/// refusals and liquidations all happen; the rest is uniform.
fn terms() -> impl Strategy<Value = Terms> {
    (
        1u64..=5_000_000_000,
        0u16..=2_200,
        prop_oneof![4 => 60i64..=7_200, 1 => 30i64..=8_000_000],
        prop_oneof![3 => (3_000u64..=6_500).prop_map(Some), 1 => (2_000u64..=9_500).prop_map(Some), 1 => Just(None)],
        1u64..=1_000_000_000_000,
        prop_oneof![4 => 4_000u16..=7_000, 1 => 0u16..=7_500],
        prop_oneof![4 => 500u16..=1_500, 1 => 0u16..=2_000],
    )
        .prop_map(|(principal, interest_bps, duration, target_ltv, raw, max_ltv, gap)| {
            // $150 with exponent -8: value = lamports * 0.15 atoms, so LTV ≈ principal * 1e6 / (lamports * 15).
            let collateral = match target_ltv {
                Some(l) => ((principal as u128 * 1_000_000) / (l as u128 * 15)).max(1) as u64,
                None => raw,
            };
            Terms { principal, interest_bps, duration, collateral, max_ltv, liq_ltv: max_ltv.saturating_add(gap) }
        })
}

fn op() -> impl Strategy<Value = Op> {
    let who = 0..USERS;
    let loan = 0usize..64;
    prop_oneof![
        3 => (who.clone(), terms()).prop_map(|(who, t)| Op::CreateOffer { who, t }),
        3 => (who.clone(), terms()).prop_map(|(who, t)| Op::CreateRequest { who, t }),
        4 => (loan.clone(), who.clone()).prop_map(|(loan, who)| Op::Accept { loan, who }),
        4 => (loan.clone(), who.clone()).prop_map(|(loan, who)| Op::Fund { loan, who }),
        1 => (loan.clone(), who.clone()).prop_map(|(loan, who)| Op::CancelOffer { loan, who }),
        1 => (loan.clone(), who.clone()).prop_map(|(loan, who)| Op::CancelRequest { loan, who }),
        3 => (loan.clone(), who.clone()).prop_map(|(loan, who)| Op::Repay { loan, who }),
        2 => (loan.clone(), who.clone()).prop_map(|(loan, who)| Op::Claim { loan, who }),
        3 => (loan.clone(), who.clone()).prop_map(|(loan, who)| Op::Liquidate { loan, who }),
        1 => (loan.clone(), who.clone()).prop_map(|(loan, who)| Op::Close { loan, who }),
        1 => (loan.clone(), who.clone()).prop_map(|(loan, who)| Op::CloseRequest { loan, who }),
        6 => (prop_oneof![3 => 9_000u64..=18_000, 2 => 3_000u64..=9_000, 1 => 1_000u64..=50_000], prop_oneof![4 => 0u64..=200, 1 => 0u64..=400], prop_oneof![4 => 0i64..=60, 1 => 0i64..=200])
            .prop_map(|(cents, conf_bps, age)| Op::Price { cents, conf_bps, age }),
        3 => (prop_oneof![4 => 1i64..=600, 1 => 1i64..=10_000_000], prop::bool::weighted(0.8)).prop_map(|(secs, refresh)| Op::Warp { secs, refresh }),
    ]
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &isolated_loan::ID).0
}
fn ata(owner: Pubkey, mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN.as_ref(), mint.as_ref()], &ATA).0
}
fn usdc_vault(offer: Pubkey) -> Pubkey {
    pda(&[USDC_VAULT_SEED, offer.as_ref()])
}
fn wsol_vault(offer: Pubkey) -> Pubkey {
    pda(&[WSOL_VAULT_SEED, offer.as_ref()])
}
fn request_vault(request: Pubkey) -> Pubkey {
    pda(&[REQUEST_WSOL_VAULT_SEED, request.as_ref()])
}

fn rank(s: OfferStatus) -> u8 {
    match s {
        OfferStatus::Open => 0,
        OfferStatus::Filled => 1,
        _ => 2,
    }
}

struct Price {
    price: i64,
    conf: u64,
    publish: i64,
}

struct Fuzz {
    svm: LiteSVM,
    users: Vec<Keypair>,
    price_key: Pubkey,
    price: Price,
    now: i64,
    next_id: u64,
    offers: Vec<Pubkey>,
    requests: Vec<Pubkey>,
    last: std::collections::HashMap<Pubkey, OfferStatus>,
    successes: u64,
    current: String,
}

impl Fuzz {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/isolated_loan.so");
        svm.add_program_from_file(isolated_loan::ID, so).expect("run `anchor build` first");
        let users: Vec<Keypair> = (0..USERS).map(|_| Keypair::new()).collect();
        for u in &users {
            svm.airdrop(&u.pubkey(), 1_000_000_000_000).unwrap();
        }
        let mut f = Fuzz {
            svm,
            users,
            price_key: Pubkey::new_unique(),
            price: Price { price: 15_000_000_000, conf: 15_000_000, publish: START },
            now: START,
            next_id: 1,
            offers: vec![],
            requests: vec![],
            last: Default::default(),
            successes: 0,
            current: String::new(),
        };
        f.set_clock();
        f.put_mint(USDC_MINT, 6);
        f.put_mint(WSOL_MINT, 9);
        for i in 0..USERS {
            let k = f.users[i].pubkey();
            f.put_ata(USDC_MINT, k, USDC_EACH);
            f.put_ata(WSOL_MINT, k, WSOL_EACH);
        }
        f.post_price();
        f
    }

    fn set_clock(&mut self) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = self.now;
        self.svm.set_sysvar(&c);
    }

    fn put(&mut self, key: Pubkey, owner: Pubkey, data: Vec<u8>, extra: u64) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len()) + extra;
        self.svm.set_account(key, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
    }

    fn put_mint(&mut self, mint: Pubkey, decimals: u8) {
        let mut d = vec![0u8; 82];
        d[44] = decimals;
        d[45] = 1;
        self.put(mint, TOKEN, d, 0);
    }

    fn put_ata(&mut self, mint: Pubkey, owner: Pubkey, amount: u64) {
        let mut d = vec![0u8; 165];
        d[0..32].copy_from_slice(mint.as_ref());
        d[32..64].copy_from_slice(owner.as_ref());
        d[64..72].copy_from_slice(&amount.to_le_bytes());
        d[108] = 1;
        let mut extra = 0;
        if mint == WSOL_MINT {
            let rent = self.svm.minimum_balance_for_rent_exemption(165);
            d[109] = 1;
            d[113..121].copy_from_slice(&rent.to_le_bytes());
            extra = amount;
        }
        self.put(ata(owner, mint), TOKEN, d, extra);
    }

    fn post_price(&mut self) {
        let u = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: VerificationLevel::Full,
            price_message: PriceFeedMessage {
                feed_id: SOL_USD_FEED_ID,
                price: self.price.price,
                conf: self.price.conf,
                exponent: -8,
                publish_time: self.price.publish,
                prev_publish_time: self.price.publish - 1,
                ema_price: self.price.price,
                ema_conf: self.price.conf,
            },
            posted_slot: 1,
        };
        let mut d = Vec::new();
        u.try_serialize(&mut d).unwrap();
        self.put(self.price_key, PYTH_RECEIVER_PROGRAM_ID, d, 0);
    }

    /// The price the program will accept now, if any.
    fn valid_price(&self) -> Option<(i64, u64)> {
        let p = &self.price;
        let fresh = self.now - p.publish <= 60;
        let conf_ok = (p.conf as u128) * 10_000 <= (p.price as u128) * 200 && p.conf < p.price as u64;
        (fresh && conf_ok && p.price > 0).then_some((p.price, p.conf))
    }

    /// Picks an offer. Four times in five it is one in `want`'s state, so steps
    /// mostly reach real paths; otherwise any offer, to keep wrong-state calls.
    fn pick_offer(&self, i: usize, want: impl Fn(&Offer) -> bool) -> Option<(Pubkey, Offer)> {
        let all: Vec<(Pubkey, Offer)> = self.offers.iter().filter_map(|k| self.offer(*k).map(|o| (*k, o))).collect();
        let fit: Vec<(Pubkey, Offer)> = all.iter().filter(|(_, o)| want(o)).cloned().collect();
        let pool = if i % 5 != 0 && !fit.is_empty() { fit } else { all };
        pool.get(i % pool.len().max(1)).cloned()
    }

    fn pick_request(&self, i: usize, want: impl Fn(&LoanRequest) -> bool) -> Option<(Pubkey, LoanRequest)> {
        let all: Vec<(Pubkey, LoanRequest)> = self.requests.iter().filter_map(|k| self.request(*k).map(|r| (*k, r))).collect();
        let fit: Vec<(Pubkey, LoanRequest)> = all.iter().filter(|(_, r)| want(r)).cloned().collect();
        let pool = if i % 5 != 0 && !fit.is_empty() { fit } else { all };
        pool.get(i % pool.len().max(1)).cloned()
    }

    /// Four times in five, a user other than `not`; otherwise `who` unchanged.
    fn other_than(&self, who: usize, not: Pubkey, i: usize) -> usize {
        if i % 5 != 0 && self.users[who].pubkey() == not { (who + 1) % USERS } else { who }
    }

    /// Four times in five, the user `want`; otherwise `who` unchanged.
    fn usually(&self, who: usize, want: Pubkey, i: usize) -> usize {
        if i % 5 != 0 { self.users.iter().position(|u| u.pubkey() == want).unwrap_or(who) } else { who }
    }

    fn amount(&self, key: Pubkey) -> u64 {
        self.svm.get_account(&key).filter(|a| a.lamports > 0 && a.data.len() >= 72).map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap())).unwrap_or(0)
    }

    fn exists(&self, key: Pubkey) -> bool {
        self.svm.get_account(&key).map(|a| a.lamports > 0).unwrap_or(false)
    }

    fn offer(&self, key: Pubkey) -> Option<Offer> {
        let a = self.svm.get_account(&key).filter(|a| a.lamports > 0)?;
        Some(Offer::try_deserialize(&mut a.data.as_slice()).unwrap())
    }

    fn request(&self, key: Pubkey) -> Option<LoanRequest> {
        let a = self.svm.get_account(&key).filter(|a| a.lamports > 0)?;
        Some(LoanRequest::try_deserialize(&mut a.data.as_slice()).unwrap())
    }

    /// (usdc, wsol) per user.
    fn wallets(&self) -> Vec<(u64, u64)> {
        self.users.iter().map(|u| (self.amount(ata(u.pubkey(), USDC_MINT)), self.amount(ata(u.pubkey(), WSOL_MINT)))).collect()
    }

    fn idx(&self, key: Pubkey) -> usize {
        self.users.iter().position(|u| u.pubkey() == key).expect("known user")
    }

    fn send(&mut self, ix: Instruction, who: usize) -> bool {
        self.svm.expire_blockhash();
        let k = self.users[who].insecure_clone();
        let tx = Transaction::new(&[&k], Message::new(&[ix], Some(&k.pubkey())), self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        if let Err(e) = &res {
            if std::env::var("FUZZ_DEBUG").is_ok() {
                let last = e.meta.logs.iter().rev().find(|l| l.contains("Error") || l.contains("failed")).cloned().unwrap_or_default();
                eprintln!("{} {:?} {}", self.current, e.err, last);
            }
        }
        let ok = res.is_ok();
        self.successes += ok as u64;
        ok
    }

    fn ix<A: ToAccountMetas, D: InstructionData>(a: A, d: D) -> Instruction {
        Instruction { program_id: isolated_loan::ID, accounts: a.to_account_metas(None), data: d.data() }
    }

    // ---- invariants ----

    fn check_state(&mut self) -> Result<(), TestCaseError> {
        let mut usdc_total: u128 = 0;
        let mut wsol_total: u128 = 0;
        for (u, w) in self.wallets() {
            usdc_total += u as u128;
            wsol_total += w as u128;
        }
        for o in self.offers.clone() {
            let uv = self.amount(usdc_vault(o));
            let wv = self.amount(wsol_vault(o));
            usdc_total += uv as u128;
            wsol_total += wv as u128;
            match self.offer(o) {
                Some(off) => {
                    match off.status {
                        OfferStatus::Open => {
                            prop_assert_eq!(uv, off.principal, "open offer vault holds the principal");
                            prop_assert!(!self.exists(wsol_vault(o)));
                        }
                        OfferStatus::Filled => {
                            prop_assert!(!self.exists(usdc_vault(o)), "filled offer has no USDC vault");
                            prop_assert_eq!(wv, off.collateral_amount, "filled loan vault holds the collateral");
                        }
                        _ => {
                            prop_assert!(!self.exists(usdc_vault(o)) && !self.exists(wsol_vault(o)), "settled loan holds nothing");
                        }
                    }
                    if let Some(prev) = self.last.get(&o) {
                        let (a, b) = (rank(*prev), rank(off.status));
                        prop_assert!(b >= a, "status moved backwards");
                        if a == 2 {
                            prop_assert!(*prev == off.status, "a settled loan never changes");
                        }
                    }
                    self.last.insert(o, off.status);
                }
                None => {
                    prop_assert!(uv == 0 && wv == 0, "closed offer left tokens behind");
                    if let Some(prev) = self.last.get(&o) {
                        prop_assert!(rank(*prev) == 2, "only a settled offer can be closed");
                    }
                }
            }
        }
        for r in self.requests.clone() {
            let rv = self.amount(request_vault(r));
            wsol_total += rv as u128;
            if let Some(req) = self.request(r) {
                if req.status == RequestStatus::Open {
                    prop_assert_eq!(rv, req.collateral_amount, "open request vault holds the collateral");
                } else {
                    prop_assert!(!self.exists(request_vault(r)), "settled request holds nothing");
                }
            } else {
                prop_assert_eq!(rv, 0);
            }
        }
        prop_assert_eq!(usdc_total, USDC_EACH as u128 * USERS as u128, "USDC conserved");
        prop_assert_eq!(wsol_total, WSOL_EACH as u128 * USERS as u128, "wSOL conserved");
        Ok(())
    }

    // ---- one step ----

    fn step(&mut self, op: Op) -> Result<(), TestCaseError> {
        self.current = format!("{:?}", op).split([' ', '{']).next().unwrap_or("").to_string();
        let before = self.wallets();
        let mut expect: Vec<(i128, i128)> = vec![(0, 0); USERS];
        let (ok, must_succeed): (bool, bool);
        let pk = |f: &Fuzz, i: usize| f.users[i].pubkey();

        match op {
            Op::Warp { secs, refresh } => {
                // Pyth publishes continuously; most jumps come with a fresh update.
                self.now += secs;
                self.set_clock();
                if refresh {
                    self.price.publish = self.now;
                    self.post_price();
                }
                return self.check_state();
            }
            Op::Price { cents, conf_bps, age } => {
                let price = cents as i64 * 1_000_000;
                self.price = Price { price, conf: (price as u64) * conf_bps / 10_000, publish: self.now - age };
                self.post_price();
                return self.check_state();
            }
            Op::CreateOffer { who, t } => {
                let id = self.next_id;
                self.next_id += 1;
                let lender = pk(self, who);
                let offer = pda(&[OFFER_SEED, lender.as_ref(), &id.to_le_bytes()]);
                ok = self.send(
                    Self::ix(
                        isolated_loan::accounts::CreateOffer {
                            lender, offer, usdc_mint: USDC_MINT, wsol_mint: WSOL_MINT, usdc_vault: usdc_vault(offer),
                            lender_usdc: ata(lender, USDC_MINT), token_program: TOKEN, associated_token_program: ATA, system_program: SYSTEM,
                        },
                        isolated_loan::instruction::CreateOffer {
                            offer_id: id, principal: t.principal, interest_bps: t.interest_bps, duration_seconds: t.duration,
                            collateral_amount: t.collateral, max_ltv_bps: t.max_ltv, liquidation_ltv_bps: t.liq_ltv,
                        },
                    ),
                    who,
                );
                let valid = math::validate_terms(t.interest_bps, t.duration, t.max_ltv, t.liq_ltv).is_ok() && before[who].0 >= t.principal;
                prop_assert_eq!(ok, valid, "create_offer accepts exactly the valid terms: {:?}", t);
                if ok {
                    self.offers.push(offer);
                    expect[who].0 -= t.principal as i128;
                }
                must_succeed = false;
            }
            Op::CreateRequest { who, t } => {
                let id = self.next_id;
                self.next_id += 1;
                let borrower = pk(self, who);
                let request = pda(&[REQUEST_SEED, borrower.as_ref(), &id.to_le_bytes()]);
                ok = self.send(
                    Self::ix(
                        isolated_loan::accounts::CreateRequest {
                            borrower, request, usdc_mint: USDC_MINT, wsol_mint: WSOL_MINT, request_vault: request_vault(request),
                            borrower_wsol: ata(borrower, WSOL_MINT), borrower_usdc: ata(borrower, USDC_MINT),
                            token_program: TOKEN, associated_token_program: ATA, system_program: SYSTEM,
                        },
                        isolated_loan::instruction::CreateRequest {
                            request_id: id, principal: t.principal, interest_bps: t.interest_bps, duration_seconds: t.duration,
                            collateral_amount: t.collateral, max_ltv_bps: t.max_ltv, liquidation_ltv_bps: t.liq_ltv,
                        },
                    ),
                    who,
                );
                let valid = math::validate_terms(t.interest_bps, t.duration, t.max_ltv, t.liq_ltv).is_ok() && before[who].1 >= t.collateral;
                prop_assert_eq!(ok, valid, "create_request accepts exactly the valid terms: {:?}", t);
                if ok {
                    self.requests.push(request);
                    expect[who].1 -= t.collateral as i128;
                }
                must_succeed = false;
            }
            Op::Accept { loan, who } => {
                let Some((o, off)) = self.pick_offer(loan, |o| o.status == OfferStatus::Open) else { return Ok(()) };
                let who = self.other_than(who, off.lender, loan);
                let b = pk(self, who);
                ok = self.send(
                    Self::ix(
                        isolated_loan::accounts::AcceptOffer {
                            borrower: b, offer: o, lender: off.lender, price_update: self.price_key, usdc_vault: usdc_vault(o),
                            wsol_mint: WSOL_MINT, wsol_vault: wsol_vault(o), borrower_usdc: ata(b, USDC_MINT), borrower_wsol: ata(b, WSOL_MINT),
                            token_program: TOKEN, associated_token_program: ATA, system_program: SYSTEM,
                        },
                        isolated_loan::instruction::AcceptOffer {},
                    ),
                    who,
                );
                if ok {
                    prop_assert!(off.status == OfferStatus::Open && b != off.lender, "accept only an open offer, not your own");
                    let (p, c) = self.valid_price().ok_or_else(|| TestCaseError::fail("accept with an invalid price"))?;
                    let debt = math::debt(off.principal, off.interest_bps).unwrap();
                    let value = math::collateral_value_usdc(off.collateral_amount, p, c, -8).unwrap();
                    prop_assert!(math::current_ltv_bps(debt, value).unwrap() <= off.max_ltv_bps, "accept above max LTV");
                    expect[who].0 += off.principal as i128;
                    expect[who].1 -= off.collateral_amount as i128;
                }
                must_succeed = false;
            }
            Op::Fund { loan, who } => {
                let Some((r, req)) = self.pick_request(loan, |r| r.status == RequestStatus::Open) else { return Ok(()) };
                let who = self.other_than(who, req.borrower, loan);
                let id = self.next_id;
                self.next_id += 1;
                let l = pk(self, who);
                let offer = pda(&[OFFER_SEED, l.as_ref(), &id.to_le_bytes()]);
                ok = self.send(
                    Self::ix(
                        isolated_loan::accounts::FundRequest {
                            lender: l, request: r, borrower: req.borrower, price_update: self.price_key, offer, wsol_mint: WSOL_MINT,
                            request_vault: request_vault(r), wsol_vault: wsol_vault(offer), lender_usdc: ata(l, USDC_MINT),
                            borrower_usdc: ata(req.borrower, USDC_MINT), token_program: TOKEN, associated_token_program: ATA, system_program: SYSTEM,
                        },
                        isolated_loan::instruction::FundRequest { offer_id: id },
                    ),
                    who,
                );
                if ok {
                    prop_assert!(req.status == RequestStatus::Open && l != req.borrower, "fund only an open request, not your own");
                    let (p, c) = self.valid_price().ok_or_else(|| TestCaseError::fail("fund with an invalid price"))?;
                    let debt = math::debt(req.principal, req.interest_bps).unwrap();
                    let value = math::collateral_value_usdc(req.collateral_amount, p, c, -8).unwrap();
                    prop_assert!(math::current_ltv_bps(debt, value).unwrap() <= req.max_ltv_bps, "fund above max LTV");
                    self.offers.push(offer);
                    expect[who].0 -= req.principal as i128;
                    expect[self.idx(req.borrower)].0 += req.principal as i128;
                }
                must_succeed = false;
            }
            Op::CancelOffer { loan, who } => {
                let Some((o, off)) = self.pick_offer(loan, |o| o.status == OfferStatus::Open) else { return Ok(()) };
                let who = self.usually(who, off.lender, loan);
                let s = pk(self, who);
                ok = self.send(
                    Self::ix(
                        isolated_loan::accounts::CancelOffer { lender: s, offer: o, usdc_vault: usdc_vault(o), lender_usdc: ata(s, USDC_MINT), token_program: TOKEN },
                        isolated_loan::instruction::CancelOffer {},
                    ),
                    who,
                );
                if ok {
                    prop_assert!(s == off.lender && off.status == OfferStatus::Open, "only the lender cancels an open offer");
                    expect[who].0 += off.principal as i128;
                }
                must_succeed = s == off.lender && off.status == OfferStatus::Open;
            }
            Op::CancelRequest { loan, who } => {
                let Some((r, req)) = self.pick_request(loan, |r| r.status == RequestStatus::Open) else { return Ok(()) };
                let who = self.usually(who, req.borrower, loan);
                let s = pk(self, who);
                ok = self.send(
                    Self::ix(
                        isolated_loan::accounts::CancelRequest { borrower: s, request: r, request_vault: request_vault(r), borrower_wsol: ata(s, WSOL_MINT), token_program: TOKEN },
                        isolated_loan::instruction::CancelRequest {},
                    ),
                    who,
                );
                if ok {
                    prop_assert!(s == req.borrower && req.status == RequestStatus::Open, "only the borrower cancels an open request");
                    expect[who].1 += req.collateral_amount as i128;
                }
                must_succeed = s == req.borrower && req.status == RequestStatus::Open;
            }
            Op::Repay { loan, who } => {
                let Some((o, off)) = self.pick_offer(loan, |o| o.status == OfferStatus::Filled) else { return Ok(()) };
                let who = self.usually(who, off.borrower, loan);
                let b = pk(self, who);
                ok = self.send(
                    Self::ix(
                        isolated_loan::accounts::RepayLoan {
                            borrower: b, offer: o, wsol_vault: wsol_vault(o), borrower_usdc: ata(b, USDC_MINT), lender: off.lender,
                            lender_usdc: ata(off.lender, USDC_MINT), borrower_wsol: ata(b, WSOL_MINT), token_program: TOKEN,
                        },
                        isolated_loan::instruction::RepayLoan {},
                    ),
                    who,
                );
                let debt = math::debt(off.principal, off.interest_bps).unwrap();
                let allowed = off.status == OfferStatus::Filled && b == off.borrower && self.now < off.expiry_ts;
                if ok {
                    prop_assert!(allowed, "repay only by the borrower before expiry");
                    expect[who].0 -= debt as i128;
                    expect[who].1 += off.collateral_amount as i128;
                    expect[self.idx(off.lender)].0 += debt as i128;
                }
                must_succeed = allowed && before[who].0 >= debt;
            }
            Op::Claim { loan, who } => {
                let Some((o, off)) = self.pick_offer(loan, |o| o.status == OfferStatus::Filled) else { return Ok(()) };
                ok = self.send(
                    Self::ix(
                        isolated_loan::accounts::ClaimExpiredLoan {
                            caller: pk(self, who), offer: o, wsol_vault: wsol_vault(o), lender: off.lender,
                            lender_wsol: ata(off.lender, WSOL_MINT), borrower: off.borrower, token_program: TOKEN,
                        },
                        isolated_loan::instruction::ClaimExpiredLoan {},
                    ),
                    who,
                );
                let allowed = off.status == OfferStatus::Filled && self.now >= off.expiry_ts;
                if ok {
                    prop_assert!(allowed, "claim only a filled loan after expiry");
                    expect[self.idx(off.lender)].1 += off.collateral_amount as i128;
                }
                must_succeed = allowed;
            }
            Op::Liquidate { loan, who } => {
                let Some((o, off)) = self.pick_offer(loan, |o| o.status == OfferStatus::Filled) else { return Ok(()) };
                let who = self.other_than(self.other_than(who, off.borrower, loan), off.lender, loan);
                let c = pk(self, who);
                ok = self.send(
                    Self::ix(
                        isolated_loan::accounts::LiquidateLoan {
                            caller: c, offer: o, price_update: self.price_key, wsol_vault: wsol_vault(o), caller_usdc: ata(c, USDC_MINT),
                            lender: off.lender, lender_usdc: ata(off.lender, USDC_MINT), borrower: off.borrower,
                            borrower_wsol: ata(off.borrower, WSOL_MINT), caller_wsol: ata(c, WSOL_MINT), token_program: TOKEN,
                        },
                        isolated_loan::instruction::LiquidateLoan {},
                    ),
                    who,
                );
                let debt = math::debt(off.principal, off.interest_bps).unwrap();
                let split = self.valid_price().and_then(|(p, cf)| {
                    let value = math::collateral_value_usdc(off.collateral_amount, p, cf, -8).ok()?;
                    let ltv = math::current_ltv_bps(debt, value).ok()?;
                    (ltv >= off.liquidation_ltv_bps).then(|| {
                        let seize = math::seize_usdc(debt).unwrap();
                        math::wsol_to_caller(off.collateral_amount, seize, value).ok()
                    })
                })
                // Collateral worth under one USDC atom cannot be split, so it is not
                // liquidatable; the lender claims it at expiry (audit I2).
                .flatten();
                // The lender's own wallet cannot liquidate: its USDC account would be both
                // payer and payee, which Anchor refuses (audit I1). It can claim at expiry.
                let allowed = off.status == OfferStatus::Filled && c != off.borrower && c != off.lender && self.now < off.expiry_ts && split.is_some();
                if ok {
                    prop_assert!(allowed, "liquidate only an unhealthy loan, before expiry, not by the borrower");
                    let to_caller = split.unwrap();
                    expect[who].0 -= debt as i128;
                    expect[self.idx(off.lender)].0 += debt as i128;
                    expect[who].1 += to_caller as i128;
                    expect[self.idx(off.borrower)].1 += (off.collateral_amount - to_caller) as i128;
                }
                must_succeed = allowed && before[who].0 >= debt;
            }
            Op::Close { loan, who } => {
                let Some((o, off)) = self.pick_offer(loan, |o| rank(o.status) == 2) else { return Ok(()) };
                let who = self.usually(who, off.lender, loan);
                let s = pk(self, who);
                ok = self.send(Self::ix(isolated_loan::accounts::CloseOffer { lender: s, offer: o }, isolated_loan::instruction::CloseOffer {}), who);
                let allowed = s == off.lender && rank(off.status) == 2;
                if ok {
                    prop_assert!(allowed, "only the lender closes a settled offer");
                }
                must_succeed = allowed;
            }
            Op::CloseRequest { loan, who } => {
                let Some((r, req)) = self.pick_request(loan, |r| r.status != RequestStatus::Open) else { return Ok(()) };
                let who = self.usually(who, req.borrower, loan);
                let s = pk(self, who);
                ok = self.send(Self::ix(isolated_loan::accounts::CloseRequest { borrower: s, request: r }, isolated_loan::instruction::CloseRequest {}), who);
                let allowed = s == req.borrower && req.status != RequestStatus::Open;
                if ok {
                    prop_assert!(allowed, "only the borrower closes a settled request");
                }
                must_succeed = allowed;
            }
        }

        if must_succeed {
            prop_assert!(ok, "a step its rules allow was refused, so funds could be stuck");
        }
        let after = self.wallets();
        for i in 0..USERS {
            let got = (after[i].0 as i128 - before[i].0 as i128, after[i].1 as i128 - before[i].1 as i128);
            prop_assert_eq!(got, expect[i], "user {} balance change (usdc, wsol)", i);
        }
        self.check_state()
    }
}

fn cases() -> u32 {
    std::env::var("FUZZ_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(2000)
}

const NAMES: [&str; 11] = ["create_offer", "create_request", "accept", "fund", "cancel_offer", "cancel_request", "repay", "claim", "liquidate", "close", "close_request"];
static TRIED: [AtomicU64; 11] = [const { AtomicU64::new(0) }; 11];
static PASSED: [AtomicU64; 11] = [const { AtomicU64::new(0) }; 11];

fn slot(op: &Op) -> Option<usize> {
    Some(match op {
        Op::CreateOffer { .. } => 0,
        Op::CreateRequest { .. } => 1,
        Op::Accept { .. } => 2,
        Op::Fund { .. } => 3,
        Op::CancelOffer { .. } => 4,
        Op::CancelRequest { .. } => 5,
        Op::Repay { .. } => 6,
        Op::Claim { .. } => 7,
        Op::Liquidate { .. } => 8,
        Op::Close { .. } => 9,
        Op::CloseRequest { .. } => 10,
        _ => return None,
    })
}

#[test]
fn random_loan_sequences_never_leak_or_strand_funds() {
    // FUZZ_SEED replays a run; otherwise a fresh seed is printed so a failure can be replayed.
    let seed = std::env::var("FUZZ_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or_else(|| {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64
    });
    eprintln!("FUZZ_SEED={seed}");
    let config = ProptestConfig {
        cases: cases(),
        failure_persistence: None,
        rng_seed: proptest::test_runner::RngSeed::Fixed(seed),
        ..ProptestConfig::default()
    };
    let mut runner = proptest::test_runner::TestRunner::new(config);
    let result = runner.run(&prop::collection::vec(op(), 1..80), |ops| {
        let mut f = Fuzz::new();
        for op in ops {
            let s = slot(&op);
            let before = f.successes;
            f.step(op)?;
            if let Some(i) = s {
                TRIED[i].fetch_add(1, Ordering::Relaxed);
                if f.successes > before {
                    PASSED[i].fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        Ok(())
    });
    // Coverage: how often each instruction ran and how often the program accepted it.
    for (i, name) in NAMES.iter().enumerate() {
        eprintln!("{name:>15}: {:>7} tried, {:>7} succeeded", TRIED[i].load(Ordering::Relaxed), PASSED[i].load(Ordering::Relaxed));
    }
    if let Err(e) = result {
        panic!("{e}\nreplay with FUZZ_SEED={seed}");
    }
}
