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
