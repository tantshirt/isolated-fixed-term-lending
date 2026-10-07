# Research

This note is the field and the math for a one-week isolated fixed-term loan. A lender locks USDC. A borrower locks wSOL and receives the USDC. The program repays, expires, or liquidates the loan. Nothing in that path needs a server.

Numbers below are either taken from a primary source or marked as a capstone choice. Capstone choices are the simple rule we will code, after looking at how the larger protocols do it.

## What the field actually does

Pooled lenders (Kamino, marginfi) put many borrowers and lenders in shared reserves. The rate moves with utilization. A position can hold several assets. Risk parameters are set per asset by the protocol, including a liquidation threshold a bit above max LTV, a close factor so one liquidation does not seize everything, and a liquidation bonus. Kamino's public docs describe current LTV as risk-adjusted debt divided by collateral value, with no grace period once liquidation LTV is crossed, and a partial close (their product docs describe 10% per round). marginfi's docs describe account health, a confidence-band-adjusted price, and a 5% liquidation fee split between the liquidator and an insurance fund.

Loopscale is the closer cousin. It is isolated and fixed-rate. A borrower locks collateral and takes a lender's offer for a stated amount, duration, and rate. Terms in their docs run from about a day to about three months. Debt used for health includes principal plus the interest for the full term. Health is `1 - current LTV / liquidation LTV`. Liquidation LTV is set per collateral. They try a partial liquidation, then auto-refinance a healthy loan at maturity, with a grace period if no new lender is found. They use Pyth for debt-asset prices.

Sources:

- Loopscale borrow overview, health and liquidations, and the "why Loopscale" note: https://docs.loopscale.com/using-loopscale/borrow/overview and https://docs.loopscale.com/using-loopscale/borrow/health-and-liquidations
- Kamino liquidations: https://kamino.com/docs/products/borrow/liquidations
- marginfi introduction and mrgnlend guide: https://docs.marginfi.com/introduction and https://docs.marginfi.com/mrgnlend
- Pyth Solana pull integration and best practices: https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/solana and https://docs.pyth.network/price-feeds/core/best-practices
- Pyth receiver addresses: https://docs.pyth.network/price-feeds/core/contract-addresses/solana
- SOL/USD feed id from Hermes on 3 Oct 2026: `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` (`Crypto.SOL/USD`)

## What we take, and what we leave

We take isolation, a fixed rate, a fixed duration, full-term interest inside the debt, a liquidation LTV above the origination LTV, Pyth with a staleness check, and a pessimistic price. We leave pools, utilization curves, borrow factors, partial liquidation, auto-refinance, grace periods, and insurance funds. Those need more accounts than the six instructions in the seven-day plan.

The plan's expiry rule is specific: after the deadline, collateral transfers to the lender. That is a hard default, not a refinance. The interface has to say that before a borrower accepts.

## Locked formulas

All math is integer. Use `u128` for every multiply and divide, then convert back to `u64`. No floats.

USDC amounts are atoms with 6 decimals. wSOL amounts are lamports with 9 decimals. Basis points use 10,000 as one whole (100%).

### Interest and debt

Interest is a single rate for the whole term, not an APR that accrues per second. The borrower owes it whether they repay on the first minute or the last.

```
interest = ceil(principal * interest_bps / 10_000)
         = (principal * interest_bps + 9_999) / 10_000
debt     = principal + interest
```

Ceiling the interest so the lender is not shorted by a rounding remainder. Early repayment does not reduce `debt`. Capstone choice: this is simpler than per-second accrual and matches a fixed term the borrower can read before signing.

### Collateral value

Pyth reports `(price ± conf) * 10^exponent`. The SOL/USD feed id above is the only feed this program accepts.

Read it with `PriceUpdateV2::get_price_no_older_than` at verification level Full, maximum age 60 seconds. Also require:

- The account owner is the Pyth Solana Receiver, `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` (same address on mainnet and devnet).
- `price > 0`, `conf < price`, and `conf * 10_000 <= price * 200` (confidence no wider than 2% of price).
- `exponent` is from -12 through -3 inclusive. The live SOL/USD exponent is -8. The formula below still works for any exponent in that range.

Value the collateral at `price - conf`, and round down. That is the bottom of the published band, which is the conservative side for a lender.

```
divisor_exp = 3 - exponent          # 11 when exponent is -8
value_usdc  = floor( lamports * (price - conf) / 10^divisor_exp )
```

`value_usdc` is in USDC atoms. Flooring means we never overstate the collateral.

### LTV

```
current_ltv_bps = ceil(debt * 10_000 / value_usdc)
```

If `value_usdc` is 0, the loan is unhealthy. Round the LTV up so a position that is even one atom over the line is caught. The result is stored as a `u16`, so it saturates at `65_535` instead of failing. A loan whose collateral has collapsed must still read as liquidatable.

At accept, require `current_ltv_bps <= max_ltv_bps`.

The loan may be liquidated when `current_ltv_bps >= liquidation_ltv_bps`.

Health, for display only, follows Loopscale's shape, in basis points:

```
health_bps = max(0, 10_000 - current_ltv_bps * 10_000 / liquidation_ltv_bps)
```

100% health means the loan is as far from liquidation as this definition allows. 0% means it is on the line. Do not use health inside the program. The program compares basis points.

### Liquidation payment

The caller pays `debt` USDC to the lender and receives wSOL worth the debt plus 5%. The rest of the wSOL returns to the borrower.

```
seize_usdc = ceil(debt * 10_500 / 10_000)
to_caller  = ceil(lamports * seize_usdc / value_usdc)
```

If `to_caller` is greater than the vault balance, the caller receives all of the collateral and the borrower receives none. A caller who would lose money simply does not send the transaction. The lender and borrower cannot liquidate this loan; the program requires a distinct liquidator.

The 5% is a capstone choice informed by marginfi's 5% liquidation fee. There is no insurance fund, so the whole bonus goes to the caller. The 5-point gap we require between max LTV and liquidation LTV leaves room for that bonus at the moment a loan first becomes liquidatable, until the price gaps through.

### Protocol caps

These are capstone choices. They are tighter than a production SOL market on purpose, because expiry gives the lender the collateral and week 1 has one price feed.

| Cap | Value | Why |
| --- | --- | --- |
| Max origination LTV | 70% (`7000` bps) | Below the roughly 75–80% SOL LTVs discussed for pooled markets. Leaves a gap before liquidation. |
| Minimum gap | Liquidation LTV at least 5 points above max LTV | Stops a loan from being liquidatable in the same breath it is opened. |
| Max liquidation LTV | 85% (`8500` bps) | A lender cannot set a threshold that only trips after the collateral is already gone. |
| Max term interest | 20% of principal (`2000` bps) | A demo cannot accidentally owe multiples of the principal. |
| Duration | 60 seconds through 90 days | Loopscale's published terms are about a day to three months. The 60-second floor lets tests use a short term. |
| Price age | 60 seconds | Pyth's own examples use 30 or 60. Sixty is the week-1 constant. |
| Confidence width | 2% of price | Rejects a feed that is too unsure to lend against. |
| Liquidation bonus | 5% of debt | See above. |

Whoever posts the terms (the lender on an offer, the borrower on a request) chooses the rate, the term, the principal, the collateral amount, the max LTV, and the liquidation LTV, inside those caps. The max LTV is checked at the price when the loan starts: at accept for an offer, at funding for a request.

## Worked example

Price `150.00` with confidence `0.15` and exponent `-8`:

- `price = 15_000_000_000`
- `conf = 15_000_000`
- conservative price `= 14_985_000_000`
- 1 wSOL values at `149.85` USDC (`149_850_000` atoms)

Principal `100` USDC, term interest `5%` (`500` bps):

- interest `= 5` USDC exactly
- debt `= 105` USDC
- at 70% max LTV, collateral must be worth at least `150` USDC
- that is `1_001_001_002` lamports, about `1.001001002` wSOL, at this price
- liquidation at 80% trips when collateral value is `131.25` USDC or less
- the caller who liquidates pays `105` USDC and is owed `110.25` USDC of wSOL; the rest returns to the borrower

Tests should assert these integers, not a rounded dollar display.

## Clock boundary

`expiry_ts` is the first second the loan is expired.

- Repay is allowed only while `clock.unix_timestamp < expiry_ts`.
- Claim-expired is allowed when `clock.unix_timestamp >= expiry_ts`.
- At the exact second, repay fails and claim succeeds.

## Assumptions still in force

- USDC is $1. A USDC depeg is invisible to this program in week 1.
- The local test mints stand in for USDC (6 decimals) and wSOL (9 decimals). They are not the mainnet mints.
- Mainnet USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` and wrapped SOL `So11111111111111111111111111111111111111112` are the week-2 targets, not week 1.
- Local tests build a `PriceUpdateV2` whose owner is the receiver program id. They do not turn the owner check off.
- No Pyth-specific agent skill was available beyond the Solana Foundation development skill. These checks are the oracle spec.

## V2 accounting (approved 2026-10-07)

Everything above stays the rule for the legacy programs. The V2 programs use the model below, implemented once in `crates/loan-core/src/accounting.rs` and mirrored in `app/lib/loan-math-v2.ts`. `crates/loan-core/vectors-v2.json` is generated from Rust scenarios and replayed in TypeScript (`npm run test:ts`). `tests/accounting_props.rs` checks the invariants over random terms and payment sequences (`npm run test:fuzz`).

### Terms fixed at origination

| Term | Rule |
| --- | --- |
| Term interest | `interest_bps` of principal for the whole term, at most 20% (as in V1) |
| Early repayment | `FullTerm`: the full-term interest is owed whenever the borrower repays. `ProRata`: interest accrues on outstanding principal until maturity. |
| Minimum interest (pro-rata) | `ceil(full_term_interest × min_interest_bps / 10_000)`. Default 2,500 (25%). Never above the ceiling. |
| Grace | Default 86,400 s, allowed 86,400–172,800 s (24–48 hours) |
| Late fee | Default 100 bps, at most 500 bps of principal unpaid at maturity |
| Annual pricing ceiling | Above 0 and at most 60,000 bps (600%), a Devnet test setting, not a compliance claim. A desk policy sets its own lower ceiling. |

`full_term_interest = ceil(P0 × interest_bps / 10_000)`, the V1 formula.

The charge ceiling is a maximum, so it rounds down:

```
charge_ceiling = floor(P0 × annual_ceiling_bps × (duration + grace) / (10_000 × 31_536_000))
```

The basis is the contract period (term plus grace) on a 365-day year. A loan whose full-term interest is above its ceiling is rejected at origination. After that, the ceiling clamps every later charge.

Origination LTV uses the maximum contractual exposure:

```
max_exposure = P0 + min(full_term_interest + ceil(P0 × late_fee_bps / 10_000), charge_ceiling)
```

### Ledger and order of operations

The ledger holds:
- outstanding principal;
- accrued and paid interest;
- the accrual remainder;
- the last accrual time;
- the assessed and paid late fee, and whether the late fee has been checked.

Every instruction first brings the ledger up to the chain clock. It accrues first, then assesses the late fee.

**Pro-rata accrual** runs from the last accrual time up to `min(now, maturity)`:

```
num = outstanding × interest_bps × dt + remainder        (u128)
accrued += num / (10_000 × duration);  remainder = num % (10_000 × duration)
```

At maturity, a non-zero remainder is rounded up by one atom, exactly once. With no partial payments this makes total interest equal V1's `ceil`. The round-up happens before the late fee, so contract interest takes the ceiling's room first. Accrual then stops. Every addition is clamped to the remaining ceiling headroom.

**Late fee**: from the first second at or after maturity, charged once:

```
late_fee = min(ceil(outstanding_at_maturity × late_fee_bps / 10_000), headroom)
```

**Payments** go to accrued interest, then the unpaid late fee, then principal. A payment of at least the payoff closes the loan and takes only the payoff; anything smaller is partial. Reaching zero principal does not close the loan while charges remain.

**Final payoff** of a pro-rata loan adds a one-time adjustment, clamped to headroom: the remainder rounded up (only when paying before maturity), plus any gap up to the minimum interest after interest already paid.

**Payoff**:

```
payoff = outstanding + accrued + unpaid late fee + final adjustment
```

Health, liquidation and settlement all use this payoff.

### Timeline

| From (inclusive) | Phase | Allowed |
| --- | --- | --- |
| start | Active | Repay (partial or full), add collateral, risk liquidation |
| maturity | Grace | The same; the late fee now applies. Maturity alone does not allow overdue liquidation. |
| maturity + grace | Overdue | Overdue liquidation regardless of LTV: the caller pays the payoff and takes collateral worth payoff × 1.05 (rounded up); the surplus returns to the borrower |
| grace end + 86,400 s | Priced recovery | Also: the lender takes collateral worth the payoff with no bonus, at a valid price. The surplus returns, and any uncovered payoff is recorded as `shortfall`. |
| grace end + 604,800 s | Terminal | Also: the lender may claim all remaining collateral without an oracle. This is an agreed default remedy that can lose surplus, disclosed before signing. |

Repayment stays open in every phase until a settlement executes. The first settlement to execute moves the loan to its single terminal status.

### Oracle policy

The spot price must pass every V1 check, and its conservative value is `price - conf`. The EMA comes from the same verified, fresh message and must pass the same band checks using its own confidence (`read_sol_usd_spot_and_ema`).

- **Ordinary risk liquidation**: conservative spot LTV ≥ threshold **and** conservative EMA LTV ≥ threshold.
- **Emergency liquidation**: conservative spot LTV ≥ threshold + 300 bps, whatever the EMA says. This is the exception to wick protection, for a crash the average has not caught up with.
- An invalid spot never qualifies. An invalid EMA allows only the emergency path.
- The EMA does not stop a caller from choosing among recent valid updates; that accepted risk (S3) remains.

### Display

- The annualized rate shown to users is `floor(interest_bps × 31_536_000 / duration)`, on a 365-day year.
- Term cost, annualized pricing and current payoff are always shown as separate figures.

## Expansion rules (Epic 26, approved 2026-10-07)

The owner waived the Epic 25 customer gate on 2026-10-07 and pulled all of Epic 26 forward. These rules apply only to the V2 programs. The legacy programs keep their week-1 economics. Each rule below is written before the code that uses it; if a test disagrees with a rule, change both in the same change.

### Per-asset collateral (26.2)

Each collateral asset has a governance-written config: mint, decimals, Pyth feed id, max LTV, liquidation LTV, and an enabled flag. Canonical wSOL keeps the built-in constants above, so active wSOL loans need no migration. Every oracle check from "Collateral value" and "Oracle policy" still applies; only the feed id and decimals come from the config.

```
divisor_exp = decimals - 6 - exponent     # 11 for SOL or jitoSOL (9 decimals) at exponent -8
value_usdc  = floor( amount * (price - conf) / 10^divisor_exp )
```

| Asset | Feed | Max LTV | Liquidation LTV | Emergency |
| --- | --- | --- | --- | --- |
| wSOL | SOL/USD `ef0d8b6f…b56d` | up to 70% | up to 85% | threshold + 300 bps |
| jitoSOL | JITOSOL/USD `67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb` | up to 60% (provisional) | up to 70% (provisional) | threshold + 300 bps |

The enabled flag gates new originations only (create, accept, fund). Liquidation, overdue liquidation and priced recovery of an existing loan keep reading the asset's feed after it is disabled, so a governance switch can never freeze recovery. Accept and fund re-check the asset's current caps, so a tightened cap stops pending offers and requests that exceed it.

jitoSOL is priced by its own verified feed, never derived from SOL/USD and a stake-pool rate. On Devnet the collateral is a ZenLo test mint labelled "jitoSOL (test)", priced by the real JITOSOL/USD feed posted through the Pyth receiver in the same transaction.

### Refinance and rollover (26.1)

A borrower may move an Active or Grace loan into a new offer in one instruction. Overdue and later phases cannot refinance; the recovery rules apply.

```
payoff_old    = payoff of the old loan at now (pro-rata final adjustment and any late fee included)
contribution  = payoff_old - new_principal        # borrower pays this; must be >= 0
```

- `new_principal > payoff_old` is rejected. Refinancing never pays cash out to the borrower.
- The old lender receives exactly `payoff_old`: `new_principal` from the new lender plus `contribution` from the borrower, in the same instruction.
- Collateral moves vault to vault. The new loan must pass origination against a fresh price with its own terms: `max_exposure` LTV within the new max LTV.
- The new loan locks exactly its offer's required collateral. Collateral above that returns to the borrower; any gap comes from the borrower in the same instruction.
- The borrower signs a bound, `max_contribution`, so interest accruing between quote and execution can never take more than they saw.
- USDC in the new offer's vault beyond its principal returns to the new lender, not the borrower (unlike `accept_offer`), so a refinance can never pay the borrower USDC.
- The old loan's terminal status is `Refinanced`, separate from `Repaid`. It never counts as a repayment in history.
- Same-lender rollover is a renewal offer restricted to that borrower. Nothing refinances without the borrower's signature; there is no auto-refinance.
- No new rounding: every amount is already in atoms.

### Automation mandates (26.3)

A borrower may pre-authorize one bounded action per loan: top-up (add collateral) or repay. A mandate is bound to the loan, action, source token account, destination vault, trigger, expiry, cumulative cap and fee cap. Only the configured keeper executes it.

- **Health trigger**: fires when conservative spot LTV ≥ `trigger_ltv_bps`, which must be below the liquidation LTV. After firing it re-arms only once LTV ≤ `trigger_ltv_bps - 200`, so one wick cannot drain the cap.
- **Time trigger**: fires once when `now ≥ maturity - lead_seconds`.
- **Amount per execution**: the mandate's fixed amount, clamped to the remaining cumulative cap; a repay is also clamped to the payoff.
- **Fees**: each execution's keeper fee is at most `fee_per_exec`, and total fees at most `fee_cap`. Fees come from the same delegated allowance and count toward the cumulative cap.
- A mandate never acts after a settlement. If a liquidation and a mandate land in the same slot, whichever executes first wins; the other fails cleanly.
- A mandate allowance is never used as liquidation capital. Revoking the mandate or the token delegate stops it at once.

Decisions made while building 26.3 and 26.4 (2026-10-07):

- **Allowance.** The SPL approval is exactly `cumulative_cap`, because fees count toward the cap. `used` adds every amount and fee; `fee_cap ≤ cumulative_cap` and `fee_per_exec ≤ fee_cap` are checked at creation.
- **One per loan and action.** The PDA is `["mandate", offer, action]`, so a loan can hold one top-up and one repay mandate. A token account has one SPL delegate: a second mandate on the same account replaces the first one's delegation, and the first then fails closed (`MandateDelegateRevoked`).
- **Fees.** The keeper names the fee; above `fee_per_exec` or past `fee_cap` it is refused, never clamped. The fee is paid in the source asset (collateral for a top-up, USDC for a repay). Private mandates have no keeper, so no fee.
- **Hysteresis.** A fired mandate always disarms. A health trigger re-arms only through an explicit observation of LTV ≤ trigger − 200 bps at a valid price: `rearm_mandate` (keeper or borrower) on the public program, or the crank itself in the rollup. A top-up that lowers LTV does not re-arm in the same transaction. The trigger must be above 200 bps so the re-arm level is positive.
- **Time trigger.** Fires once from `maturity − lead_seconds` (`0 < lead ≤ duration`) and never re-arms. It keeps working in grace and later until a settlement executes, as repayment does.
- **Price.** Health triggers use only the conservative spot (`price − conf`) of the collateral's own feed against the payoff, as at origination; no EMA. A stale price fails the public call and makes the private run a no-op.
- **Private repay destination.** A private repay mandate is bound to the current lender's USDC ATA when it is created. After a sale it does nothing until the borrower creates a new one.
- **Pool operations (26.4).** Quote parameters are financial policy, so `authorities.governance` writes them, not the liquidation-pool admin key. Only the quote TTL is a parameter (30–600 s). Draining unused pool liquidity is not built: every pool atom backs a funded ticket or an unclaimed payout, the pool has no on-chain liability ledger, and its balances live in delegated ER accounts the Squads vault cannot sign for. A safe drain needs a liability counter kept by fund, settle, refund and every watch, plus a governance order executed in the rollup. That is a follow-up.

### Credit tiers (26.7)

An invited wSOL credit pilot lets a verified borrower originate at a higher max LTV. The tier comes from a Solana Attestation Service credential that carries only the tier and an expiry.

| Tier | Max LTV | Liquidation LTV | Emergency |
| --- | --- | --- | --- |
| 1 | 80% | 85% | 88% |
| 2 | 85% | 90% | 93% |
| 3 | 88% | 93% | 96% |

- The liquidation LTV is always max LTV + 5 points, the existing minimum gap. Credit tiers override the 70% max LTV and 85% liquidation caps only through a valid, unexpired credential checked at origination.
- The tier is fixed at origination and stored on the loan. A credential that expires during the loan does not change it.
- The 5% liquidation bonus still fits: at 93% LTV the collateral is worth about 107.5% of the debt.
- Reclaim income proofs are verified server-side and discarded; only the resulting attestation is kept. Raw proofs, income figures and viewing keys never reach Convex, telemetry, exports or notifications.

Decisions made while building 26.7 (2026-10-07):

- **Which tier terms need.** The smallest tier whose max and liquidation caps both cover the terms. Terms within 70% / 85% need no credential and record tier 0 even if one is passed. Above tier 3 is refused.
- **Credential lifetime.** Valid only when the SAS account expiry is 0 or in the future **and** the schema's own `expiry` is in the future. The pilot issuer sets both to 180 days from verification.
- **Invitation.** A restricted (single-borrower) wSOL offer, or a request (which names its borrower) funded by a lender who chooses it. Open offers cannot carry credit caps.
- **Income bands (pilot).** Verified monthly income below $2,000 is ineligible; $2,000–4,999 is tier 1; $5,000–9,999 is tier 2; $10,000 and above is tier 3 (`app/lib/credit/bands.ts`). Only the band and tier leave the route.
- **History.** On time = repaid at or before maturity; late = repaid after maturity; defaulted = overdue liquidation, priced recovery or terminal claim; a risk liquidation and a refinance are counted separately and are never repayments.

### Secondary market (26.8)

A lender may sell a V2 position. Every V2 position is transferable; the borrower's terms never change, only who is paid.

- The buyer pays the seller's asking price and becomes `current_lender` in one instruction. The vault PDA keeps signing with `origin_lender`.
- Everything paid after the sale, including interest that accrued before it, goes to `current_lender`. Any shortfall belongs to `current_lender`.
- A listing is void once the loan settles or the seller is no longer `current_lender`.
- Every loan review states that the position may be sold and that payments then go to the new holder.

Decisions made while building 26.8 (2026-10-07):

- **Every position is sellable.** There is no assignable flag. The borrower's terms, ledger, collateral and deadlines are untouched by a sale; only `current_lender` moves, and the vault PDAs keep signing with `origin_lender`.
- **When.** A position can be listed and bought only while the loan is `Active` and in its Active or Grace phase. From the end of grace the loan belongs to recovery (overdue liquidation, priced recovery, the terminal claim), and a sale would race those claims, so listing and buying are refused (`PositionNotSellable`).
- **One listing per loan.** `["listing", offer]`. Listing again by the same holder updates price and expiry in place. The seller can cancel at any time.
- **Exact price.** The buyer signs `expected_price`; if the seller re-listed at another price in between, the purchase fails (`ListingPriceChanged`) rather than charging a different amount. The price goes to the listing's seller and nowhere else.
- **Void listings.** A listing is void once the loan settles (any terminal status, including `Refinanced`), its account is closed, the seller is no longer `current_lender`, or it expires. A void listing cannot be bought; anyone may close it and the rent returns to the seller.
- **Atomicity.** A purchase and a repayment race to one outcome: a repayment built for the old lender fails the payee check after a sale, and a purchase after a closing repayment fails on status.
- **Mandates.** A public repay mandate pays `current_lender` at execution, so after a sale it pays the buyer with no change. A private repay mandate stays bound to the lender named at its creation and does nothing after a sale until the borrower creates a new one (already decided in 26.3).
- **Private sales.** Inside the rollup, seller and buyer both sign `transfer_position(price, readers)`. The buyer pays from their private USDC balance to the seller's; the loan's read permission is rewritten so the seller loses read access and the buyer gains it, and consented auditors stay. There is no private order book: the price is agreed privately and bound by both signatures. The client follows with `rebind_watch` so the liquidation crank pays the buyer.

### Activity export (26.8)

One row per on-chain action: UTC time, slot, signature, loan, role, action, asset, amount in atoms, decimal amount, fee, and resulting status. Public rows are rebuilt from chain with a `(slot, signature)` cursor, so a replay yields the same file. Private rows are exported only in the browser from rollup reads and never pass through a server. The export is an activity record, not tax advice.

- **Fields.** `time_utc` is the block time in ISO 8601 with `Z`; `amount_atoms` is the exact integer; `amount` is the same value written with the asset's decimals by integer arithmetic, never a float; `fee` is the network fee in lamports for public rows (`0` for private rows, where the rollup charges none); `status` is the loan status after the action. The column order and file footer are in [architecture.md](architecture.md#activity-export-story-268).
- **Cursor.** Public rows sort by `(slot, signature)`, then loan, then action; exact duplicates are dropped, so the same chain data in any order yields a byte-identical file. An export "since the last one" returns the public rows strictly after the saved cursor. Private rows come from the decoded rollup ledger (origination, interest, late fee and principal paid to date, any shortfall, the settlement) rather than per transaction; they carry slot 0 and a synthetic `private:<loan>:<action>` signature and are always included. A private sale price is not stored on the loan, so a buyer's private row records the holding with amount 0.
