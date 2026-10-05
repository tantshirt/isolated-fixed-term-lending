# Stories

Two lanes. Neither lane is assigned to a person. Say which lane you are on, then take the next open story in that lane from [sprint-plan.md](sprint-plan.md).

The program lane builds the Anchor program, accounts, vaults, and loan instructions. The oracle and client lane builds the price checks, the tests, the client scripts, and the docs that sit next to the code.

Week-2 stories are listed so they are not forgotten. They stay out of the seven days.

## Epic 1. Program skeleton

Day 2. Program lane, with the oracle and client lane on the test fixtures.

### Story 1.1. Anchor project and offer account

The repo builds an Anchor program whose offer account matches [architecture.md](architecture.md): fields, status enum, and the three PDA seed sets.

Acceptance:

- `anchor build` succeeds.
- The offer PDA is derived from `["offer", lender, offer_id]`.
- Both vault seed sets are derived as specified, and a unit test checks the addresses.
- Status values exist for Open, Filled, Repaid, Expired, Liquidated, and Cancelled.

### Story 1.2. Local mints and wallets

Three wallets exist in the test setup: lender, borrower, liquidator. Two classic SPL mints exist: 6 decimals and 9 decimals. Each wallet can hold both.

Acceptance:

- A test creates the mints and the token accounts and asserts the decimals.
- The same setup is what later instruction tests call. They do not each invent a mint.

## Epic 2. Create, cancel, and accept

Day 3.

### Story 2.1. Create and cancel

Program lane.

Acceptance:

- The lender can create an offer and the USDC vault balance equals `principal`.
- A rate, term, or LTV outside the caps in [research.md](research.md) fails.
- The lender can cancel an open offer and receives the USDC back.
- A stranger cannot cancel.
- Cancelling a filled offer fails with the wrong-status error.

### Story 2.2. Accept

Oracle and client lane for the price account. Program lane for the token moves. Pair on this story.

Acceptance:

- Accept moves principal USDC to the borrower and `collateral_amount` wSOL into the wSOL vault.
- `start_ts` and `expiry_ts` come from the Clock sysvar.
- The USDC vault is closed after accept.
- Accept fails when the worked example's collateral would break the 70% cap, using the integers in the research note.
- The borrower and the lender cannot be the same pubkey.

## Epic 3. Repay and expiry

Day 4.

### Story 3.1. Repay

Program lane.

Acceptance:

- Before `expiry_ts`, the borrower pays `debt` USDC to the lender and receives every lamport of wSOL back.
- `debt` matches `ceil(principal * interest_bps / 10_000) + principal` from the research note.
- Repay at `expiry_ts` fails.
- A second repay fails.
- A stranger cannot repay.

### Story 3.2. Claim expired

Oracle and client lane.

Acceptance:

- Claim at `expiry_ts - 1` fails.
- Claim at `expiry_ts` sends all wSOL to the lender and none to the borrower.
- No USDC moves on claim.
- Claim before the loan is filled fails.
- A second claim fails.

## Epic 4. Oracle and liquidation

Day 5.

### Story 4.1. Price checks

Oracle and client lane.

Acceptance:

- Accept and liquidate call `get_price_no_older_than` with a 60 second maximum age and Full verification.
- The account owner must be `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`.
- The feed id must be `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`.
- Confidence wider than 2% of price, a non-positive price, and an exponent outside -12..-3 each fail.
- Tests do not disable the owner check. They build a `PriceUpdateV2` with that owner.

### Story 4.2. Integer value and LTV

Program lane, shared with 4.1.

Acceptance:

- Pure tests assert the worked example: 1 wSOL at price 150.00 and conf 0.15 values at 149.85 USDC, the 100 USDC loan at 5% needs at least 1.001001002 wSOL at 70% LTV, and 80% liquidation trips at 131.25 USDC of collateral.
- Collateral value rounds down. LTV and interest round up. The implementation uses `u128` and rejects overflow.

### Story 4.3. Liquidate

Oracle and client lane for the cases. Program lane for the split.

Acceptance:

- A healthy loan fails with the healthy-loan error.
- An unhealthy loan moves `debt` USDC from the caller to the lender, sends the caller wSOL worth debt plus 5%, and returns the remainder to the borrower.
- The borrower cannot liquidate.
- Liquidate at or after `expiry_ts` fails. Claim is the only ending then.
- A stale price and a mismatched feed id fail, and no tokens move.

## Epic 5. The three outcomes, end to end

Day 6. Oracle and client lane, with the program lane fixing whatever the tests find.

### Story 5.1. Permission and double-settlement sweep

Acceptance:

- A test matrix covers stranger cancel, stranger repay, borrower liquidate, and a second call of each settlement.
- After each ending the wSOL vault is closed and its balance is not still sitting on the offer.

### Story 5.2. Three client scripts

Acceptance:

- One script runs accept then repay and prints status `Repaid` and the expected balances.
- One script runs accept then liquidate against a crossed price and prints status `Liquidated`.
- One script runs accept, warps the clock to `expiry_ts`, claims, and prints status `Expired`.
- Each script starts from the shared local setup, not from a half-finished previous run.

## Epic 6. Make it presentable

Day 7. Both lanes.

### Story 6.1. Clean errors and a fresh run

Program lane on the errors. Oracle and client lane on the writeup.

Acceptance:

- Every failure in the stories above maps to a named error, not a generic overflow or a raw program error.
- A new clone can follow the README, run the three scripts, and see the three statuses.
- The README lists the accounts, the seeds, the six instructions, and the assumptions in the research note (USDC is one dollar, expiry gives the lender the wSOL, local mints are not mainnet).

## Epic 7. Week 2

Not in the seven-day queue. Do not start these while an Epic 1–6 story is open.

### Story 7.1. Interface

Build the screens in [design-and-experience.md](design-and-experience.md). Light Astryx Neutral tokens. The three journeys, including empty, loading, success, and error. The program remains the source of LTV.

### Story 7.2. Devnet, indexer, fuzz

Deploy to devnet with the real USDC and wSOL mints and a real Pyth update. An indexer and Trident fuzzing come after the deploy is reproducible, not before.

## Epic 8. Private protocol: compatibility and privacy proof

Private lane. This is a gate, not a feature. Each story records PASS or FAIL with raw evidence (signatures, RPC dumps) in [magicblock-evidence.md](magicblock-evidence.md). A failed gate keeps its feature unavailable. It never switches the feature to public execution and never weakens the Pyth checks.

### Story 8.1. Pin the toolchain

A new `private_loan` program builds in the `isolated_loan/` workspace beside the public program, with its own program id.

Acceptance:

- `anchor build` builds both programs with `ephemeral-rollups-sdk` 0.17.3 (feature `anchor`) on the existing anchor-lang 1.x and Rust 1.89.
- The SDK, delegation, permission, eSPL, Hydra, and TEE validator ids are pinned in one constants file and in the evidence file.
- `session-keys` builds under anchor 1.x, or the evidence records why not and Lendspan uses its own scoped session account instead.

### Story 8.2. TEE auth and permissions

Acceptance:

- A script verifies the Devnet TEE attestation and obtains an auth token before sending any private request.
- A permissioned, delegated account is readable by a member.
- An outsider gets no contents through `getAccountInfo`, `getProgramAccounts`, `accountSubscribe`, or transaction logs.

### Story 8.3. ER-only accounts

Acceptance:

- A record created with `#[ephemeral_accounts]` never appears on the base layer, before or after commit and undelegate of its neighbours.
- The behaviour of that record across a validator restart is recorded, whatever it is.

### Story 8.4. Program-controlled eSPL custody

Acceptance:

- A program PDA owns an eATA for Devnet USDC and one for wSOL.
- Deposit, delegate, a PDA-signed transfer inside the ER, and withdraw all succeed with exact balances.

### Story 8.5. Canonical Pyth inside the PER

Acceptance:

- The shared Pyth check reads the cloned Pyth Receiver `PriceUpdateV2` (owner `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`) inside the TEE.
- A stale clone fails with `StalePrice`.
- The MagicBlock pricing oracle is not accepted in its place.

### Story 8.6. Private scheduled execution

Acceptance:

- A Hydra crank calls a permissionless instruction on a private account.
- The scheduler operator holds no read permission on that account.
- A retry after the account has settled does nothing.

### Story 8.7. Commit visibility

Acceptance:

- The base-layer commit of a permissioned account is inspected, and what it exposes is written down.
- Any plaintext leak of terms or identities blocks the dependent feature.

## Epic 9. Private foundation

Private lane. Only features whose Epic 8 gate passed.

### Story 9.1. Shared loan core

The loan math and the Pyth check move into `isolated_loan/crates/loan-core`. Both programs use it.

Acceptance:

- `npm run test:rust` and `npm run test:litesvm` pass with no change to the public program's behaviour.
- The worked-example vectors live in one file that the Rust and TypeScript tests both read.

### Story 9.2. Rooms, invitations, and scoped sessions

Acceptance:

- Opening a room creates the room, its permission, and its delegation in one transaction.
- Seeds use opaque random ids, never wallets or terms.
- Only the primary wallet can invite or revoke. A link alone grants nothing.
- A session key can post a message but cannot fund, accept, repay, withdraw, grant access, or approve a disclosure.
- An expired or revoked session fails.

### Story 9.3. Private balances

Acceptance:

- A user can deposit USDC, wrap and deposit wSOL, and withdraw to a reviewed destination.
- Every externally built transaction is checked for programs, accounts, mint, amount, destination, fee payer, and network before the wallet signs.
- Fees show separately from principal and interest.

### Story 9.4. Execution receipts and recovery

Acceptance:

- A receipt records environment, intent, revision, ER signature, commit id, and base signature.
- It shows "executed" separately from "settled".
- An uncertain submission survives a reload and is reconciled without a second token movement.
- A private request is never sent to a public endpoint.

## Epic 10. Complete private loan

### Story 10.1. Fund, accept, repay, cancel, expire, withdraw

Acceptance:

- Each loan has its own PDA-owned eATAs. No instruction can move another loan's balance.
- Both approvals bind to the same terms revision. Any financial edit invalidates them.
- The shared `loan-core` vectors (worked example, rounding) back both programs. Deadline boundaries, permissions, revisions, and double-settlement rejection are checked on Devnet, because the ER instructions cannot run in LiteSVM.
- A full lifecycle runs on the Devnet TEE, and its signatures are recorded.

## Epic 11. Discovery and AI

### Story 11.1. Discovery cards and competing proposals

Acceptance:

- A public card holds only the fields the publisher selected.
- A competing lender sees their own proposal and the disclosed request, never another lender's.
- Accepting one funded offer invalidates the selection of the others. Unused funded offers stay cancellable.

### Story 11.2. AI request and callback

Acceptance:

- The user sees the exact excerpt, provider, and model before anything is sent.
- The request binds the payload hash, approval, and terms revision.
- A forged, duplicate, late, or stale callback cannot modify the current draft.
- Model output never changes loan status, prices, eligibility, or settlement.

## Epic 12. Automated settlement

### Story 12.1. Expiry tasks and liquidation tickets

Acceptance:

- Expiry runs from a permissionless crank with fixed destinations, and it is harmless after settlement.
- A liquidator funds a ticket from a short-lived quote without reading the loan.
- Execution rechecks price, status, deadline, and limits. It settles once, or the ticket becomes refundable.
- The Devnet liquidator's capital is separate from user deposits.

### Story 12.2. Magic Actions receipts

Acceptance:

- A minimal receipt is posted on settlement.
- A direct, forged, or duplicate action call fails.

## Epic 13. Optional integrations and polish

### Story 13.1. Transfers, sponsorship, lab, and accessibility

Acceptance:

- Private transfers and gas sponsorship are bounded and never change approved financial contents.
- `/devnet/private/lab` VRF scenarios and SOAR achievements are opt-in and confer no loan advantage.
- Keyboard, mobile, wallet switching, and rejected signatures all work on `/devnet/private`.

## Epic 14. Discover marketplace

### Story 14.1. Borrower requests

Acceptance:

- A borrower can post a request that locks collateral, cancel it while open, and close it once funded or cancelled.
- A lender funds a request in one instruction. Funding checks Pyth and the max LTV, pays the borrower, and creates an ordinary filled offer.
- Repay, claim, liquidate, and close work on that offer unchanged. The `Offer` layout does not change.
- Rent returns to whoever paid it, in amount.

### Story 14.2. Client and live reads

Acceptance:

- The client lists open requests, offers, and discovery cards from Devnet.
- Lists update within seconds through account subscriptions and fall back to polling when the socket drops. The interface says which.

### Story 14.3. Discover page

Acceptance:

- `/devnet/discover` is in the main navigation. Borrowers asking and Lenders offering each show Public and Private.
- Private borrower cards keep the selected-fields rule from 11.1. Lenders offering in private is explained, not invented.
- A lender can fund a public request from the page, and is told first when a price update needs extra signatures.

### Story 14.4. Request a loan

Acceptance:

- A borrower chooses Public or Private. Public posts a request through a four-step wizard with a live summary. Private goes through a room and a discovery card.
- Wrapping SOL is an explicit step, never silent.
