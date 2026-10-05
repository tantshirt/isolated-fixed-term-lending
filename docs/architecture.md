# Architecture

Local Anchor program. No backend. One offer account is one loan. The formulas are specified in [research.md](research.md) and are not restated here except where an instruction needs them.

## Stack

- Rust program written with Anchor, tested with LiteSVM. Use the Anchor and Solana CLI versions that Anchor's own install docs pair together. Do not guess a combination.
- Classic SPL Token for both vaults. Test mints: 6 decimals for the dollar mint, 9 for the wrapped-SOL mint. `create_offer` rejects any other decimals (`InvalidUsdcMint`, `InvalidWsolMint`) and rejects the same mint on both legs (`SameMint`).
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

## What fails closed

- Wrong feed id, wrong owner, stale price, confidence wider than 2%, exponent outside -12..-3, or non-positive price. Liquidation and accept both fail. Repay and expiry do not read the price.
- A second repay, claim, or liquidate.
- A borrower calling liquidate on their own loan. They repay instead.
- A token account whose mint does not match the offer.
- An offer that is expired and still `Filled` cannot be repaid and cannot be liquidated. It can only be claimed.

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
- A mint with the wrong decimals, or the same mint twice, cannot create an offer.
- Only the lender can close an offer, and only after it has ended.

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
- **Sessions.** Session keys may edit drafts, post messages, revise proposals, and send already-approved AI requests. Lendspan checks room and instruction scope itself. Funding, accepting, repaying, withdrawing, granting access, and approving a disclosure need the primary wallet.
- **AI.** A request binds the approved payload hash, provider, model, and terms revision. The callback is signed by the oracle identity PDA and checked for replay, deadline, and revision. It cannot write loan state.
- **Settlement evidence.** ER execution, commit, and base-layer settlement are tracked separately. Queue acceptance is never shown as settlement.
- **Custody accounting.** Inside the TEE, no wallet can read a custody PDA's token balance; the ER returns a masked value. Loan state records principal and collateral itself, and the interface reads loan state. Token balances are checked on the base layer after settlement.
- **eSPL calls.** `private_loan/src/espl.rs` builds eSPL instructions in the order the deployed program's processors read them. Do not switch to the SDK's `spl` CPI helpers: the feature does not build for SBF, and its withdraw order is wrong in 0.17.3.
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
