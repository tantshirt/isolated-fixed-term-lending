# Product requirements

## Problem

Two people need a Solana loan they can explain on one diagram. Pooled lenders hide the rate, the counterparty, and the liquidation rule inside a shared reserve. This project is the opposite: one lender, one borrower, one chunk of USDC, one chunk of wSOL, and a program that settles the loan by itself.

## Who it is for

- A lender who wants a fixed return and a known collateral amount, and who accepts that they only get the wSOL if the borrower fails to repay or the price falls through the line.
- A borrower who wants USDC now, can lock wSOL, and can read the exact repayment and the exact deadline before they sign.
- A liquidator, who can be anyone, including the lender, and who steps in only when the loan is unhealthy.

There is no protocol admin in week 1 and no server in the loop.

## Week-1 outcome

By the end of seven days the repo has a local program with all six instructions, tests for repay, expiry, and liquidation, small client scripts that run those three flows, and docs a second person can follow. The frontend, an indexer, Trident fuzzing, and devnet deployment wait until week 2. The screens are specified now so week 2 does not invent them.

## The loan

1. The lender creates an offer and locks USDC in a vault.
2. The lender may cancel while the offer is still open and take the USDC back.
3. The borrower accepts by locking the required wSOL. They receive the principal. The clock starts.
4. The borrower repays principal plus the full-term interest and receives the wSOL back.
5. If the deadline passes unpaid, anyone may claim, and the wSOL goes to the lender.
6. If the price falls so the loan's LTV reaches the liquidation line, anyone may liquidate: they pay the debt to the lender, take wSOL worth the debt plus 5%, and the rest of the wSOL returns to the borrower.

The formulas, caps, feed id, and rounding rules are in [research.md](research.md). They are requirements, not background.

## In scope for the seven days

- An Anchor program, the offer account, PDA seeds, statuses, events, and errors.
- A USDC vault used only while the offer is open, and a wSOL vault used while the loan is open.
- Local test mints and three test wallets: lender, borrower, liquidator.
- Pyth SOL/USD checks: owner, feed id, freshness, confidence, exponent.
- Integer LTV and liquidation math.
- Tests for permissions, bad state, vault balances, double settlement, the clock boundary, stale and wrong price accounts, healthy and unhealthy loans.
- Client scripts for the three outcomes: accept then repay, accept then liquidate, accept then expire.

## Out of scope until week 2

- The interface build.
- An indexer.
- Trident fuzzing.
- Devnet or mainnet deployment.
- Partial liquidation, auto-refinance, topping up collateral, per-second interest, a USDC price feed, Token-2022, and an insurance fund.

## Success bar

A fresh local setup can run the three outcome tests without a manual database or a keeper service. A reader of [architecture.md](architecture.md) can implement an instruction without inventing a seed, a status, or a rounding direction. A reader of [design-and-experience.md](design-and-experience.md) can build the week-2 screens without inventing a layout.

## Risks we are accepting

- Expiry gives the lender all of the collateral. A borrower who is one second late loses the wSOL even if it is worth more than the debt. The accept screen must say this in a sentence, not a footnote.
- USDC is treated as one dollar. A depeg is not detected.
- A price that gaps far through the liquidation line can leave the collateral worth less than the debt. A liquidator then has no reason to call. The lender still has the expiry path.
- One feed is a single point of failure. The checks (owner, id, age, confidence, exponent) are the mitigation in week 1, not a second oracle.

## Desk-first roadmap (approved 2026-10-07)

Everything above describes the week-1 product and stays true for the legacy programs. The next product is one lending journey: find a counterparty, agree terms, fund, manage the loan, settle, and reuse the relationship. The landing promise becomes **Your repayment rules, upfront.**

Private lender desks are the first commercial hypothesis. Five to ten real lender operators are recruited during development, and a two-week observed pilot (the customer gate, Epic 25) must pass before the expansion backlog is built.

Decisions:

- Launch on public Solana Devnet with test assets. The website is the existing Next.js app on Vercel. Convex holds operational data, realtime updates and jobs. MagicBlock stays the private execution engine.
- Identity is the wallet. There is no email registration. A desk is a set of individual lender wallets, not a pooled treasury.
- Existing loans keep their original programs, terms and servicing. New economics ship in separate V2 programs with versioned accounts and clients.
- Desk pricing caps are product controls, not legal-compliance guarantees. Licensing, sanctions and jurisdiction analysis are deferred beyond this Devnet build. The business location and countries are undecided.
- MoneyGram uses the existing sandbox access and the official Ramps documentation. Advanced privacy is progressive and disclosed accurately; confidential settlement and Arcium stay research-only until a paying desk needs them.

The stories are Epics 19–27 in [stories.md](stories.md), and the order is the desk lane in [sprint-plan.md](sprint-plan.md). V2 lifts several week-1 exclusions for the V2 programs only: per-second (pro-rata) accrual, topping up collateral, partial repayment and a grace period.
