# Architecture

Local Anchor program. No backend. One offer account is one loan. The formulas are specified in [research.md](research.md) and are not restated here except where an instruction needs them.

## Stack

- Rust program written with Anchor, tested with LiteSVM. Use the Anchor and Solana CLI versions that Anchor's own install docs pair together. Do not guess a combination.
- Classic SPL Token for both vaults. Test mints: 6 decimals for the dollar mint, 9 for the wrapped-SOL mint. `create_offer` rejects any other decimals (`InvalidUsdcMint`, `InvalidWsolMint`) and rejects the same mint on both legs (`SameMint`). It then accepts only canonical Devnet USDC `4zMMC9…ncDU` and native wSOL `So111…112` (`MintNotAllowed`), because collateral is always priced as SOL/USD. `create_request` and the private `create_loan` apply the same pin. Only a `local-mints` build, used for Surfpool walkthroughs, accepts other mints; it is never deployed.
- Version pairing in this repo: the program builds with `anchor-lang` 1.x; the TypeScript client still uses `@coral-xyz/anchor` 0.32, which reads the 1.x IDL. Upgrading the client is its own change.
- Pyth pull price via `PriceUpdateV2` and `pyth-solana-receiver-sdk`. Receiver program `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`. Feed id `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`.
- Clock sysvar for the deadline. Do not trust a client timestamp.
- Client scripts are thin: they build the transactions and print the resulting status and balances. They are not a server.

Week 2 may add a web client on the design in [design-and-experience.md](design-and-experience.md). Week 1 does not.

## Accounts

Offer PDA seeds: `["offer", lender_pubkey, offer_id_le_bytes]`. `offer_id` is a `u64` the lender chooses. A repeat of the same pair fails because the address already exists.

USDC vault seeds: `["usdc-vault", offer_pubkey]`. This vault holds the principal only while the status is Open. Accept, cancel, and the settlement instructions empty it and close it when it is no longer needed.

wSOL vault seeds: `["wsol-vault", offer_pubkey]`. This vault holds collateral from accept until repay, expiry, or liquidation.

Both vaults are SPL token accounts. Their authority is the offer PDA, signed with the offer seeds. The mint on each vault is checked against the mint stored on the offer.

### Offer fields

| Field | Type | Notes |
| --- | --- | --- |
| lender | pubkey | Signer on create and cancel. Receives repayment, or collateral on expiry. |
| borrower | pubkey | Set on accept. Signer on repay. |
| offer_id | u64 | Part of the offer seed. |
| usdc_mint | pubkey | 6 decimals in tests. |
| wsol_mint | pubkey | 9 decimals in tests. |
| principal | u64 | USDC atoms locked at create. |
| interest_bps | u16 | Whole-term rate. Max 2000. |
| duration_seconds | i64 | 60 through 7,776,000 (90 days). |
| collateral_amount | u64 | Lamports the borrower must lock. |
| max_ltv_bps | u16 | Max 7000. |
| liquidation_ltv_bps | u16 | At least `max_ltv_bps + 500`, and at most 8500. |
| start_ts | i64 | Clock at accept. 0 before that. |
| expiry_ts | i64 | `start_ts + duration_seconds`. |
| status | enum | Below. |
| bump | u8 | Offer PDA bump. |

Status values: `Open`, `Filled`, `Repaid`, `Expired`, `Liquidated`, `Cancelled`.

There is no protocol config account in week 1. Caps are constants in the program.

## Instructions

Every instruction checks the status first and fails with `WrongStatus` on a second settlement. Every token move checks mint, owner, and amount. Every math step uses `u128` and fails with `MathOverflow` instead of wrapping.

### create_offer

Signer: lender. Status becomes `Open`.

Move `principal` USDC from the lender's token account into the USDC vault. Reject a term, rate, or LTV pair outside the caps in the research note. Emit `OfferCreated`.

### cancel_offer

Signer: lender. Status must be `Open`. Move the vault balance back to the lender, close the vault, set `Cancelled`. Emit `OfferCancelled`. The offer account stays as a receipt; see `close_offer`.

### accept_offer

Signer: borrower. Status must be `Open`. The borrower must not be the lender.

Read Pyth as specified in the research note. Compute `debt` and collateral value. Require `current_ltv_bps <= max_ltv_bps`. If the posted collateral would not cover the max LTV, fail with `InsufficientCollateral`. The required `collateral_amount` on the offer is what moves; the LTV check is on top of that amount, at the current price.

Move the USDC vault balance to the borrower. Move `collateral_amount` wSOL from the borrower into the wSOL vault. Set `borrower`, `start_ts`, `expiry_ts`, and status `Filled`. Close the USDC vault; its rent returns to the lender, who paid it at create. Emit `OfferAccepted`.

### repay_loan

Signer: borrower. Status must be `Filled`. Require `clock.unix_timestamp < expiry_ts`.

Move `debt` USDC from the borrower to the lender. Move all wSOL from the vault to the borrower. Close the vault. Set `Repaid`. Emit `LoanRepaid`.

### claim_expired_loan

Signer: anyone. Status must be `Filled`. Require `clock.unix_timestamp >= expiry_ts`.

Move all wSOL to the lender. Close the vault; its rent returns to the borrower, who paid it at accept. Set `Expired`. Emit `LoanExpired`. No USDC moves. The principal already left at accept.

### liquidate_loan

Signer: anyone except the borrower. Status must be `Filled`. The loan must not be expired yet; after `expiry_ts`, only `claim_expired_loan` is valid. This keeps the two endings from racing into different token splits.

Read Pyth with the same checks. Require `current_ltv_bps >= liquidation_ltv_bps`, else `LoanHealthy`.

Move `debt` USDC from the caller to the lender. Split the wSOL as in the research note: caller receives the seized amount, borrower receives the remainder. Close the vault; its rent returns to the borrower. Set `Liquidated`. Emit `LoanLiquidated` with the amounts.

### close_offer

Signer: lender. Status must be `Repaid`, `Expired`, `Liquidated`, or `Cancelled`, else `OfferNotSettled`. Closes the offer account and returns its rent to the lender. Emit `OfferClosed`. Until then the account is the on-chain receipt the interface reads the final status from.

Every vault and account rent goes back to whoever paid it. No caller is paid rent for calling an open instruction.

## Borrower requests

A borrower can also post terms first. A request locks the borrower's collateral; a lender funds it in one step, which creates an ordinary filled offer. From then on repay, claim, liquidate, and close are the instructions above, unchanged. The `Offer` layout does not change, so existing offers need no migration.

Request PDA seeds: `["request", borrower_pubkey, request_id_le_bytes]`. `request_id` is a `u64` the borrower chooses.

Request vault seeds: `["request-wsol", request_pubkey]`. An SPL token account whose authority is the request PDA. It holds the collateral while the request is `Open`.

### LoanRequest fields

| Field | Type | Notes |
| --- | --- | --- |
| borrower | pubkey | Signer on create, cancel, and close. Receives the principal at funding. |
| request_id | u64 | Part of the request seed. |
| usdc_mint, wsol_mint | pubkey | Same decimal and distinct-mint checks as `create_offer`. |
| principal, interest_bps, duration_seconds, collateral_amount, max_ltv_bps, liquidation_ltv_bps | | Same meaning and caps as on `Offer`. |
| created_ts | i64 | Clock at create. |
| status | enum | `Open`, `Funded`, `Cancelled`. |
| lender | pubkey | Set at funding. Default before that. |
| offer | pubkey | The offer created at funding. Default before that. |
| bump | u8 | Request PDA bump. |

### create_request

Signer: borrower. Reject terms outside the caps, a zero principal, or zero collateral. The borrower's USDC token account must already exist, so funding never has to create it. Move `collateral_amount` wSOL into the request vault. No price is read, as in `create_offer`. Emit `RequestCreated`.

### cancel_request

Signer: borrower. Status must be `Open`. Return the vault balance to the borrower, close the vault, set `Cancelled`. Emit `RequestCancelled`.

### fund_request(offer_id)

Signer: lender. Status must be `Open`. The lender must not be the borrower.

Read Pyth with the same checks as accept and require `current_ltv_bps <= max_ltv_bps`, else `InsufficientCollateral`. Create the offer at `["offer", lender, offer_id]` and its wSOL vault. Move the collateral from the request vault to the offer vault, close the request vault to the lender, and move `principal` USDC from the lender straight to the borrower. The offer copies the terms with `start_ts` now and status `Filled`. The request becomes `Funded` and records the lender and the offer. Emit `RequestFunded`.

Rent: the borrower paid for the request vault and the lender pays for the offer vault. Both are token accounts of the same size, so closing the request vault to the lender, and later the offer vault to the borrower, leaves each side even.

### close_request

Signer: borrower. Status must be `Funded` or `Cancelled`, else `RequestNotSettled`. Closes the request and returns its rent to the borrower. Emit `RequestClosed`.

## What fails closed

- Wrong feed id, wrong owner, stale price, confidence wider than 2%, exponent outside -12..-3, or non-positive price. Liquidation and accept both fail. Repay and expiry do not read the price.
- A second repay, claim, or liquidate.
- A borrower calling liquidate on their own loan. They repay instead.
- A token account whose mint does not match the offer.
- An offer that is expired and still `Filled` cannot be repaid and cannot be liquidated. It can only be claimed.
- Funding a request with a bad price, at an LTV over the cap, a second time, after cancel, or by the borrower.

## Tests the program must pass

Pure tests, no chain, for the worked example in the research note: interest, collateral value at exponent -8, origination LTV, the 80% line, and the 5% seize amount.

Instruction tests on LiteSVM:

- Lender can create and cancel. A stranger cannot cancel. Cancel returns the USDC.
- Accept moves USDC to the borrower and wSOL into the vault, and rejects a price that fails the LTV cap.
- Repay before the deadline returns wSOL and pays `debt`. Repay at `expiry_ts` fails. Claim at `expiry_ts - 1` fails. Claim at `expiry_ts` sends wSOL to the lender.
- A healthy loan cannot be liquidated. An unhealthy loan can. A stale price and a wrong feed id cannot.
- After any settlement, the same instruction fails, and the other settlement instructions fail.
- Vault balances are zero after each ending, and the closed accounts are gone.
- Vault rent returns to the party that paid it. A loan whose LTV is past `65_535` bps can still be liquidated.
- A mint with the wrong decimals, the same mint twice, or any mint other than canonical USDC and wSOL cannot create an offer or a request.
- Only the lender can close an offer, and only after it has ended.
- A borrower can create and cancel a request; a stranger cannot cancel; cancel returns the wSOL.
- Funding moves principal to the borrower and collateral into the offer vault, copies the terms, and leaves the lender's lamports changed only by the offer rent and the fee.
- Funding fails on the LTV cap, a bad price, the borrower as lender, a wrong USDC mint, a second funding, or after cancel.
- A funded request repays, claims at `expiry_ts`, and liquidates through the existing instructions.
- Only the borrower can close a request, and only once it is funded or cancelled.

These live in `isolated_loan/programs/isolated_loan/tests/litesvm.rs`. Run `npm run test:litesvm`.

## Client scripts

Three scripts, each from a fresh local setup:

- accept, then repay
- accept, then liquidate (the script posts a price that crosses the line)
- accept, then warp the clock and claim

Each script prints the offer status and the three wallets' USDC and wSOL balances at the end.

## Week-2 boundary

Devnet will swap the test mints for real USDC and wSOL and will post a real Pyth update. The account layout and the caps do not change to make that possible. The interface reads the same statuses and does not compute a second, friendlier LTV.

## Private protocol

A second program, `private_loan`, runs the private lifecycle on MagicBlock Private Ephemeral Rollups on Devnet. The public `isolated_loan` program and its loans do not change or migrate. The wallet-free simulation stays.

Decisions:

- **Shared core.** Interest, collateral value, LTV, seize, payout, term caps, and the Pyth check live in `isolated_loan/crates/loan-core`. Both programs call it, so the same vectors must pass against both.
- **Three kinds of state.**
  - Terms, counterparties, negotiation, approvals, and loan details are ER-only or permissioned accounts.
  - Token custody is in program-controlled eATAs, one set per loan.
  - Discovery cards, opaque settlement commitments, and infrastructure metadata are the only deliberately public records.
- **Seeds.** Private accounts use random 32-byte ids. No wallet, amount, or term goes into a public seed, log, task payload, or receipt.
- **Permissions.** An account and its permission are created in the same transaction. Only program rules change membership.
- **Prices.**
  - Acceptance and liquidation use the canonical Pyth Receiver account with the same owner, feed, confidence, age, and exponent checks as the public program.
  - The MagicBlock pricing oracle (owner `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`) is used for charts and alerts only.
- **Sessions.** Session keys may edit drafts, post messages, revise proposals, and send already-approved AI requests. ZenLo checks room and instruction scope itself. Funding, accepting, repaying, withdrawing, granting access, and approving a disclosure need the primary wallet.
- **AI.** A request binds the approved payload hash, provider, model, and terms revision. The callback is signed by the oracle identity PDA and checked for replay, deadline, and revision. It cannot write loan state.
- **Settlement evidence.** ER execution, commit, and base-layer settlement are tracked separately. Queue acceptance is never shown as settlement.
- **Custody accounting.** Inside the TEE, no wallet can read a custody PDA's token balance; the ER returns a masked value. Loan state records principal and collateral itself, and the interface reads loan state. Token balances are checked on the base layer after settlement.
- **eSPL calls.** `private_loan/src/espl.rs` builds eSPL instructions in the order the deployed program's processors read them. Do not switch to the SDK's `spl` CPI helpers: the feature does not build for SBF, and its withdraw order is wrong in 0.17.3.
- **What may be committed.** Committing a delegated account writes its data to Solana in plaintext (gate 8.7). Terms, negotiation, approvals, and the ticket-to-loan mapping live in ER-only records (gate 8.3) and are never committed. Only token balances and opaque receipts settle.
- **Cranks.** Hydra cranks are created inside the ER by the program, with a delegated PDA as sponsor and as cancel authority. ZenLo's worker runs the cranker; no hosted cranker was observed on the Devnet TEE.
- **Rooms.** `RoomAnchor` is the only delegated room account. It holds the room id, the creator (already public as the `open_room` signer), and 0.02 SOL to sponsor records. `RoomState`, `RoomThread`, and `SessionScope` are ER-only with member-only permissions; invite and revoke rewrite those permissions. Large ER-only records are edited in place, never deserialized whole.
- **Sessions.** ZenLo's own `SessionScope` binds a session key to one room, a scope bitmask with no financial bits, an expiry of at most one day, and a revoked flag. The key lives only in browser memory. The TEE sign-in token (not a session key) is kept for the current tab in `sessionStorage`, scoped to the wallet and its expiry, and forgotten when the wallet disconnects or changes.
- **Finding rooms and loans.** The TEE filters `getProgramAccounts` by the caller's token, so listing `RoomState` by size returns only rooms the wallet may read; matching delegated `RoomAnchor` records give each room's link. A room's loans are listed through their public `LoanAnchor.room` (byte 40), and their terms read only for the lender and the borrower. Invitations are rooms listed this way that the wallet has not opened or dismissed on this device. No inbox account exists; see [magicblock-evidence.md](magicblock-evidence.md#phase-6-finding-rooms-and-loans-story-171).
- **Private loans.** `LoanAnchor` (delegated) owns the loan's USDC and wSOL eATAs, and their base ATAs exist so the ER can mirror them. `LoanTerms` is ER-only and readable by the lender and borrower. Funding and acceptance bind the same revision; any edit bumps it. Acceptance uses the canonical Pyth check. `claim_expired` is signer-free and does nothing once settled. Parties' private balances carry no explicit eATA permission, because one would block the program (gateway 403).
- **Discovery.** `DiscoveryCard` is a public base account; the room owner publishes it on purpose, and unticked fields are stored as zero. Lenders ask through an ER-only `JoinQueue` that only the owner reads; it is a 16-slot ring read oldest first, and the owner chooses the role when letting someone in. Publishing again retracts the room's previous card instead of adding a duplicate. Each offer is its own loan readable by that lender and the borrower. The first acceptance writes an ER-only room deal record that locks out the others. Only the borrower can read it, so a lender's funded bid stays cancellable rather than marked as lost.
- **AI copilot.** The super-smart-contracts request/callback pattern, in `private_loan/src/ai.rs`. `AiConfig` (admin-set) names the worker key. `AiRequest` is ER-only (requester and worker), bound to SHA-256(model + excerpt) and the loan revision. `claim_ai_request` consumes each pending approval atomically before any paid model call, using a unique invocation nonce. Processing cannot be claimed again, even after a worker crash; the user must approve a new request. `ai_callback` requires processing state and is worker-only, single-shot, and deadline-checked, marks stale revisions, and writes only the request. The worker is `app/app/api/private/ai`, a Vercel Function calling AI Gateway.
- **Automated settlement.** Each active loan has a Hydra watch whose scheduled `watch_loan` is signer-free and idempotent: expiry pays the lender; past the line it keeps a short-lived public quote; a funded quote is executed after rechecking price, deadline, and the liquidator's minimum payout. Liquidators fund quotes from private balances into a program pool and never read the loan. A Vercel Cron cranker triggers due watches. Quote↔loan linkage is visible in the public crank account, and quote amounts disclose economics.
- **Settlement receipts.** `publish_receipt` commits the loan anchor with a Magic Action that writes `SettlementReceipt` (status and terms commitment) on Solana. `record_receipt` requires the delegation program's escrow signature bound to that loan's anchor and writes once.
- **Gates.** Each MagicBlock capability needs a passing Epic 8 gate in [magicblock-evidence.md](magicblock-evidence.md). A failed gate leaves the feature off.

Pinned ids (verified 2026-10-05):

| What | Id |
| --- | --- |
| ephemeral-rollups-sdk | 0.17.3 (Rust and TS) |
| Delegation program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Permission program | `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1` |
| eSPL program | `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2` |
| Hydra | `Hydra17i1feui9deaxu6d1TzSQMRNHeBRkDR1Awy7zea` |
| Devnet TEE validator | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` at `https://devnet-tee.magicblock.app` |
| Magic Router (Devnet) | `https://devnet-router.magicblock.app` |

Known leakage: public deposits and withdrawals, opt-in discovery cards, and liquidation quote amounts. TEE confidentiality depends on the hardware and the operator. A PER outage may block timely repayment, and the expiry rule still applies.


### Private protocol security release (2026-10-06, local)

Deploy the matching private program, IDL and application together. `fund_quote` and `settle_ticket` now require the canonical loan anchor before the quote account and validate the exact quote layout and pool mints. Existing quote storage is unchanged. Legacy clients fail closed against the updated instruction account lists.

A quote holds four ticket slots. `fund_quote` reuses refunded or paid slots, so tickets over a loan's life never exhaust them. `refund_ticket` is permissionless: anyone can push a dead ticket's refund to its owner's own USDC account, so a liquidator who never collects cannot keep a quote full. `schedule_watch` checks the price account's owner and feed before the crank stores it. See [security-audit.md](security-audit.md).

AI workers require `claim_ai_request` before a maximum of two model attempts. The claim is permanent; uncertainty or process failure does not restart spending. Old program deployments reject the new claim instruction before model spending. Sponsored first draws use `request_first_scenario` with initialization-only semantics, so concurrent approvals for the same learner cannot repeatedly fund account rent. Normal self-funded repeat draws still use `request_scenario`.

Optional sponsorship uses `PRIVATE_LAB_SPONSOR_SECRET`, a dedicated Devnet budget wallet, never the SOAR authority secret. Its whole funded balance is the spending cap. The reserve check is best effort across concurrent different learners. Configuration presence is not evidence that sponsorship is currently usable. The current release has not been deployed or tested against an upgraded hosted TEE.

## Desk-first architecture (approved 2026-10-07)

| Layer | Owns |
| --- | --- |
| Vercel / Next.js | Interface, wallet interactions, transaction reviews, authentication endpoints and simulation |
| Convex | Consented profiles, preferences, operational metadata, notifications, provider sessions, activity projections and durable jobs |
| `isolated_loan_v2` | Public V2 loan custody, authority, accounting and settlement |
| `private_loan_v2` (MagicBlock) | Private rooms, desks, membership, terms, accounting, permissions and execution |
| Provider adapters | Explicitly scoped payments, shielding, proofs, attestations, indexing and notifications |

Decisions:

- **Separate V2 programs.** New program IDs and versioned accounts, with every account starting with a version byte. The app picks a codec by program ID. Legacy programs stay readable and serviceable through their original codecs.
- **Shared accounting.** One economic model in `crates/loan-core` is used by both V2 programs, the TypeScript client, simulation, alerts and keepers, with parity vectors in `vectors-v2.json`.
- **Lender identity.** V2 loans carry an immutable `origin_lender` used for PDA signing and a mutable `current_lender` that receives repayments and claims.
- **Authentication.** A domain-bound, expiring, single-use wallet challenge leads to a short-lived JWT, which Convex verifies as custom JWT auth. Authorization is derived from the verified identity only.
- **Background work.** Durable job records with deduplication, bounded retries and reconciliation of uncertain signatures before resubmitting. One active scheduler. The Vercel Cron cranker moves to Convex only after parity testing.
- **Governance.** V2 upgrade authorities sit under a 2-of-3 Squads multisig vault with a 24-hour time lock. A `Config` account separates the AI admin, AI worker, liquidation-pool admin, credential issuer and keeper. `AI_ADMIN` is not reused for financial administration.
- **Privacy boundary.** Private conversations, full private books, raw income proofs and viewing keys never reach Convex. Private book totals are computed in an authorized context. Convex stores only the monitoring metadata the user explicitly permits.
- **Capabilities.** Each provider capability is keyed by network and mint. Flags can pause new originations or a provider without blocking recovery of existing loans.

Account layouts, seeds and instruction rules are added to this file story by story (Epics 20–24) as they are implemented. A seed is not specified here until its story is built.

## Public V2 program (`isolated_loan_v2`, Stories 21.1–21.2)

Program ID `8hxagcQkw1Km6PWZgpA92qUnqvnFufC7tx2jvxf9Ko8m`. Its authorities are the upgrade authority and, from Story 26.2, `Config.authorities.governance`; both belong to the Squads vault, and governance can only write per-asset collateral configs, never touch a loan ([governance.md](governance.md)). Economics come only from `loan_core::accounting` ([research.md](research.md#v2-accounting-approved-2026-10-07)).

### Accounts and seeds

| Account | Seeds | Notes |
| --- | --- | --- |
| `OfferV2` | `["offer-v2", origin_lender, offer_id_le]` | `version = 2`. Fields: `origin_lender` (immutable, PDA signer), `current_lender` (receives payments and claims), `borrower`, `restricted_borrower` (default = anyone), mints, `terms`, `collateral_required`, `collateral_locked`, LTV pair, `status`, `ledger`, `shortfall`, `settled_ts`, 64 reserved bytes |
| USDC vault | `["usdc-vault-v2", offer]` | Open offers only; closed at accept (rent to the origin lender) |
| wSOL vault | `["wsol-vault-v2", offer]` | Active loans; closed at settlement (rent to the borrower) |
| `RequestV2` | `["request-v2", borrower, request_id_le]` | A borrower's ask, with collateral locked in `["request-wsol-v2", request]` |
| `Config` | `["config"]` | Story 26.2. `governance::Authorities`, the same layout as `private_loan_v2`'s `Config`. Written once by the upgrade authority (`init_config`); only `authorities.governance` (the Squads vault on Devnet) rotates it or writes a `CollateralConfig`. |
| `CollateralConfig` | `["collateral", mint]` | Story 26.2. `version = 1`, `mint`, `decimals` (copied from the mint at the first write and fixed), `feed_id: [u8; 32]`, `max_ltv_bps`, `liquidation_ltv_bps`, `enabled`, `bump`, 32 reserved bytes. Never exists for canonical wSOL or USDC. |

The vault and field names keep `wsol`; for a configured asset, `OfferV2.wsol_mint` and `RequestV2.wsol_mint` hold that asset's mint and the "wSOL vault" holds it. Neither layout changed.

**Collateral resolution (Story 26.2).** Canonical wSOL always uses the built-in constants (SOL/USD, 9 decimals, 70% / 85% caps), and any extra account passed with it is ignored, so active wSOL loans need no migration. Any other collateral mint must pass its `CollateralConfig` as the **first remaining account** of `create_offer`, `create_request`, `accept_offer`, `fund_request`, `liquidate`, `liquidate_overdue` and `claim_priced_recovery`. The program checks that the account is owned by the program, is a `CollateralConfig`, names this mint and sits at `["collateral", mint]`. Origination (create, accept, fund) also requires `enabled`, the mint's decimals to match, and the terms' max and liquidation LTV to be within the config's caps (checked again at accept and fund, so a tightened or disabled asset stops pending offers and requests). Servicing (liquidation, overdue liquidation, priced recovery) reads the config's feed and decimals even when the asset is disabled, so disabling never freezes recovery. Repay, add collateral and the terminal claim read no price and need no config. Valuation is `floor(amount × (price − conf) / 10^(decimals − 6 − exponent))` with every oracle check from `loan_core::oracle::read_price`. A `local-mints` build (never deployed) with no config passed keeps pricing a self-made mint as SOL so Surfpool walkthroughs still run.

Statuses: `Open`, `Active`, `Repaid`, `Liquidated`, `OverdueLiquidated`, `PricedRecovered`, `TerminalClaimed`, `Cancelled`. Every instruction that settles a loan requires `Active`, so a loan reaches exactly one terminal status.

### Instructions

| Instruction | Who | When | Effect |
| --- | --- | --- | --- |
| `create_offer(id, terms, restricted_borrower)` | lender | — | Validates V1 caps plus V2 rules (grace 24–48 h, late fee ≤ 5%, ceiling ≤ 600% and ≥ term interest), then locks principal |
| `cancel_offer` | current lender | Open | Principal and vault rent back |
| `accept_offer` | borrower ≠ lender, matching `restricted_borrower` if set | Open | LTV of **max exposure** ≤ max LTV at the fresh spot. Principal out, collateral in, ledger opened |
| `repay(amount)` | borrower | Active, **any phase** | Interest, then late fee, then principal, paid directly to the current lender. `amount ≥ payoff` closes the loan, takes only the payoff, and returns all collateral. `amount` bounds the signature. |
| `add_collateral(amount)` | borrower | Active | No oracle needed |
| `liquidate` | anyone except the borrower | Active or Grace | Spot **and** EMA LTV ≥ threshold, or spot ≥ threshold + 300. The caller pays the payoff and takes payoff × 1.05 in wSOL; the surplus goes to the borrower |
| `liquidate_overdue` | anyone except the borrower | from grace end | The same split regardless of LTV; needs a valid spot |
| `claim_priced_recovery` | current lender | from grace end + 24 h | Payoff-equivalent wSOL with no bonus; surplus to the borrower; uncovered payoff recorded as `shortfall` |
| `claim_terminal` | current lender | from grace end + 7 d | All remaining wSOL, with no price account read |
| `close_offer` / `close_request` | current lender / borrower | settled | Rent back |
| `create_request`, `cancel_request`, `fund_request(offer_id)` | borrower / borrower / lender | — | As in V1. Funding creates an `Active` `OfferV2` and checks max exposure. |
| `init_config(authorities)` | program upgrade authority | once | Creates `Config`; every key set and no two roles sharing one |
| `rotate_authorities(next)` | `authorities.governance` | — | Replaces the keys; the result must still validate |
| `set_collateral_config(feed_id, max_ltv_bps, liquidation_ltv_bps, enabled)` | `authorities.governance` | — | Creates or updates `["collateral", mint]`. Rejects wSOL and USDC, decimals outside 3–18, a zero feed id, max LTV of 0 or above 70%, liquidation LTV above 85% or less than 5 points above max. Mint and decimals cannot change after the first write. |

Fails closed: wrong status; a signer other than the named party; a restricted borrower mismatch; any Pyth owner, feed, age, band or exponent failure on a priced path, where the feed is the collateral's own; an early call (`TooEarly`); a zero amount; any USDC mint other than canonical USDC; any collateral mint other than canonical wSOL without its `CollateralConfig` (`CollateralNotConfigured`), or with a disabled one at origination (`CollateralDisabled`); terms above the asset's caps (`InvalidTerms`); a config write by anyone but governance (`WrongAuthority`). The borrower cannot liquidate their own loan; the duplicate-account guard or `BorrowerCannotLiquidate` stops it.

`programs/isolated_loan_v2/tests/litesvm_v2.rs` (25 tests) covers each boundary to the second, including jitoSOL accept and repay, liquidation, priced recovery and request funding on the JITOSOL/USD feed, an unconfigured or substituted config, a disabled config, non-governance writes, and the unchanged wSOL path.

## Private V2 program (`private_loan_v2`, Stories 22.1–22.2)

Program ID `JAzy8NP6V8AGrAko8vfgrD44BDghN6eLwqB7vjuYhHNq`. V1 rooms and loans stay on `private_loan`.

| Record | Seeds | Where | Notes |
| --- | --- | --- | --- |
| `Config` | `["config"]` | Solana | `governance::Authorities`. Written once by the upgrade authority; only the Squads vault rotates it. Replaces the hard-coded `AI_ADMIN`. |
| `RoomAnchor` | `["room", creator, room_id]` | Delegated | Namespaced by its creator |
| `RoomState` | `["room-state", room]` | ER-only | Up to 16 members with role bits (borrower 1, lender 2, viewer 4). The owner holds only the roles they gave themselves, so there is no owner bypass. Also holds `next_loan_index`. |
| Room registry | `["room-loan", room, index_le]` | ER-only | The loan anchor for each room index, readable by the room's members |
| `LoanAnchor` | `["loan", creator, nonce_le]` | Delegated | The creator (the lender) is the only wallet that can run the first private setup. Owns the loan's eATAs. |
| `LoanTerms` | `["loan-terms", loan]` | ER-only | V2 terms and ledger, origin and current lender, room and request index, `ledger_revision`, shortfall, and reserved desk, policy-version and auditor-hash fields. Readable by lender and borrower only. |
| Deal | `["room-deal", room, request_index_le]` | ER-only | One accepted proposal per borrowing request; a room holds many requests |
| Quote | `["quote", loan]` | ER (public) | Version 2 layout: quoted debt (payoff at quote expiry), payout, ledger revision, kind (risk or overdue), and tickets with an `excess` field |

### Rules

- **Initial private setup.** `propose_terms` requires:
  - the anchor's creator as signer;
  - the anchor bound to this room;
  - an active lender role and an active borrower role;
  - a fresh registry slot.

  It allocates `next_loan_index` and writes the registry entry in the same instruction. The index is metadata only.
- **Acceptance.** `accept_loan` checks the maximum-exposure LTV at a fresh price and creates or verifies the deal for `request_index`.
- **Repayment and top-up.** `repay(amount)` and `add_collateral(amount)` follow the shared accounting. Both bump `ledger_revision`.
- **Lender recovery.** `claim_priced_recovery` and `claim_terminal` follow the public V2 rules.
- **`watch_loan`.**
  - Before grace ends it quotes only when the risk trigger fires: spot and EMA, or spot alone 300 bps past the line.
  - After grace it quotes regardless of LTV.
  - A quote is reissued when it expires, when the ledger revision changes, or when its kind changes.
  - At execution the current lender receives the exact payoff. The winning ticket's excess funding is returned by `settle_ticket` together with the wSOL payout, exactly once.
  - The watch runs through the terminal-claim window.
- **Not yet built.** Rebinding a watch after the lender changes belongs to the secondary market (Epic 26).

Tests: `programs/private_loan_v2` has 10 unit tests and 7 LiteSVM settlement tests (`npm run test:litesvm`). The Devnet TEE proof is `scripts/private/v2-rooms.ts`.

### Desks and auditors (Stories 23.1, 24.1)

| Record | Seeds | Where | Notes |
| --- | --- | --- | --- |
| `DeskAnchor` | `["desk", creator, desk_id]` | Delegated | Sponsors the desk's ER-only records |
| `DeskState` | `["desk-state", desk]` | ER-only | Up to 16 members with role bits (admin 1, lender 2, auditor 4), the current policy version and the next loan-book sequence. Admins hold the permission authority on this record only. |
| `DeskPolicy` | `["desk-policy", desk, version_le]` | ER-only | Immutable once written. Bounds principal, duration, interest, annual pricing ceiling (required), repayment modes, LTV, minimum grace, late fee, and up to 4 named auditors. |
| Desk loan book | `["desk-loan", desk, seq_le]` | ER-only | Loan anchor for each desk loan, readable by desk members |

**Rules:**
- **Setup.** `init_desk` makes the creator the first admin. `set_desk_member` adds, re-roles or removes a member, and a desk always keeps at least one admin.
- **Membership and metadata access.** Membership updates supply every existing policy (in version order) and book entry (in sequence order), each with its canonical permission account. The program checks the complete list and atomically updates all metadata audiences with the member list; omissions, concurrent new records, or any failed permission update reject the transaction. Policies and book entries grant read access only, including to admins. Loan terms retain their separate borrower-consented audiences. Existing metadata permissions are repaired on the next successful membership update, including a same-role update. This pilot implementation requires the complete update to fit the network's transaction size, account and compute limits. The client checks serialized size before signing and does not split oversized updates; if any limit is exceeded, membership and permissions stay unchanged. Larger desks need a separate access-migration design before membership changes can be supported at that size.
- **Policies.** `publish_policy` writes version n+1.
- **Attaching a draft.** `attach_desk` is run by the loan's lender, who must also be a desk lender. It checks the terms against the current policy, records the policy version and the auditor-list hash in `LoanTerms`, adds the loan to the desk book, and bumps the revision, so funding and acceptance bind the desk terms.
- **Acceptance.** `accept_loan(revision, auditor_hash)` requires the hash the borrower was shown. For a desk loan it re-checks the pinned policy and then adds the named auditors to the loan's read permission, using the same read flags as the parties and no authority.
- **Admins.** An admin never appears in a loan's permission unless they are its lender, borrower or a named auditor, so administration grants neither spending nor reading.
- **Changing readers.** `add_loan_reader` needs both the lender and the borrower to sign, so a new reader always means new consent. `remove_loan_reader` needs either one and stops future reads; it cannot unread what was already seen. Both pass the current list, which must hash to the recorded `auditor_hash`.
- **No pooled money.** Funding always comes from the proposing lender's own private balance. A desk has no treasury.
