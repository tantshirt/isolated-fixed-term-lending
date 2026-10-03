# Implementation readiness

Verdict: week-1 coding can start.

A developer can implement the six instructions without inventing a seed, a status, a rounding direction, a feed id, or a liquidation split. Those are written down. The stories point at the section that holds each rule.

## Decided

- Six instructions and the status each one requires. See [architecture.md](architecture.md).
- PDA seeds for the offer, the USDC vault, and the wSOL vault. The USDC vault is empty after accept.
- Debt is principal plus full-term interest, rounded up. Collateral is priced at Pyth price minus confidence, rounded down. LTV is rounded up.
- Caps: 70% max LTV, 5 point gap, 85% liquidation ceiling, 20% max term interest, 60 seconds to 90 days, 60 second price age, 2% confidence width, 5% liquidation bonus.
- SOL/USD feed id and the Pyth receiver program id.
- Expiry at `expiry_ts` sends all wSOL to the lender. Repay is only strictly before that second. Liquidation is only strictly before that second.
- Tests use LiteSVM and a real owner check on a constructed price update.
- The interface is specified and is not part of the seven days.

## Assumptions that are not blockers

- USDC is one dollar. Week 2 can add a USDC feed. Week 1 must not pretend it has one.
- Local mints stand in for USDC and wSOL. The mainnet mint addresses are recorded and unused.
- Expiry is intentionally harsh. The accept screen says so. The program does not grow a grace period to soften it.
- If the price gaps so the collateral is worth less than the debt, a liquidator may not show up. The lender's path is still the expiry claim.
- Anchor and Solana CLI versions are whatever Anchor's install guide pairs, chosen on the day the project is created. They are not pinned in this note, because a stale pin is worse than the guide.

## Not ready, on purpose

- No frontend build, indexer, Trident suite, or devnet deploy. Those are Epic 7.
- No partial liquidation and no refinance. Adding them would contradict the expiry rule.

## Before the first pull request

Read [AGENTS.md](../AGENTS.md), take the next open story in [sprint-plan.md](sprint-plan.md), and implement only that story's acceptance checks.
