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

The lender still chooses the rate, the term, the principal, the collateral amount, the max LTV, and the liquidation LTV, inside those caps.

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
