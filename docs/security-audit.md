# Security audit

Audit date: 2026-10-06. Scope: both Devnet programs, the shared `loan-core` crate, and the Next.js app. The question is whether anyone can lose money: a vault paying out what it should not, funds stuck forever, or a user signing something they did not review.

| Program | Id | Upgrade authority (Devnet, read 2026-10-06) |
| --- | --- | --- |
| `isolated_loan` (public loan) | `CKvMgaAJmtoUN73wDxAKvjYs2d5fcirttjjEjrV9hnef` | `3dh3Bxu1hJzH3aHfwNAibRqTxyrPsUFyteiuGxycoohh` |
| `private_loan` (MagicBlock TEE) | `HwK4hxKqe94pLGkC9bGciENCCzvWwUAaz1mxVTDxMcK` | `3dh3Bxu1hJzH3aHfwNAibRqTxyrPsUFyteiuGxycoohh` |

The same deployer wallet also holds `AI_ADMIN` in `private_loan/src/ai.rs:21`. It is one hot key on one machine. Both programs stay upgradeable for Devnet work. Freezing them is out of scope.

## Threat model

| Who | What they could take | What stops them |
| --- | --- | --- |
| Borrower | Principal without real collateral, or collateral back without repaying | Pinned mints (S2), Pyth LTV check at accept, status checks on every settle path |
| Lender | Collateral before expiry, or more than the debt | Repay before expiry returns all collateral; claim needs `now >= expiry`; liquidation needs LTV ≥ the liquidation threshold |
| Liquidator | More collateral than debt × 1.05 | `loan-core` seize math, capped at the vault balance |
| Stranger | Anything in a vault | Every vault is a PDA owned by its offer, request, loan anchor or pool; only those seeds sign |
| Griefer | Nothing directly, but can block liquidation so the lender takes bad debt | S1 and S4 fixes |
| Web attacker | Tricks a user into signing | Reviewed-transaction validator, Devnet genesis check (A1), CSP and frame protection (A2) |

## What already holds

- No secrets are committed. Keypairs and `.env.local` are git-ignored and kept out of Vercel uploads.
- Pyth: owner `rec5EK…`, SOL/USD feed id, Full verification, 60 s max age, confidence ≤ 2 %, exponent in [-12, -3]. Collateral is valued at price − conf.
- All math is u128 with checked operations, and overflow checks are on in release. Rounding always favours the lender or the liquidator, as `research.md` says.
- Every settlement checks status first, so a loan cannot be paid out twice. Existing LiteSVM tests cover wrong signer, bad oracle, double settlement and clock boundaries.
- The simulation (`/demo`) imports no wallet or RPC code, so it cannot send a transaction.
- The public loan flow refuses to sign unless the RPC genesis hash is Devnet's.

## Findings

| # | Severity | Where | Problem | Fix | Status |
| --- | --- | --- | --- | --- | --- |
| S1 | High | `private_loan/src/settle.rs` `watch_loan`, `fund_quote` | The quote's ticket count never resets. After four tickets over a loan's life, refunded ones included, no quote can be funded again, and liquidation stops for good. Anyone can trigger this with refundable deposits. | `fund_quote` reuses settled slots and fails only when four live tickets are held. Refunds of old tickets are permissionless. | Open |
| S2 | High | `isolated_loan/src/contexts.rs` (`CreateOffer`, `CreateRequest`); `private_loan/src/loan.rs` (`create_loan`) | Mints are checked only for decimals, yet collateral is always priced as SOL. A borrower can post a worthless 9-decimal token and get real USDC. A lender can offer a fake USDC with a freeze authority. | Pin USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` and wSOL `So11111111111111111111111111111111111111112` in `loan-core`. A `local-mints` feature turns pinning off for localnet builds only. | Open |
| S4 | Medium | `private_loan/src/settle.rs` `schedule_watch` | The scheduler picks the price account baked into the crank, and `watch_loan` ignores oracle errors. A bogus account means the crank never liquidates. | Check owner and feed id when scheduling. | Open |
| A1 | Medium | `app/lib/private/rooms.ts`, `loans.ts`, `discovery.ts`; `app/lib/server/soar.ts` | These base-layer sends skip the Devnet genesis check. | Call `assertDevnet` first. | Open |
| A2 | Medium | `app/next.config.ts` | No CSP and no frame protection. The signing UI can be framed by another site. | Add CSP, `frame-ancestors 'none'`, `Referrer-Policy`, `X-Content-Type-Options`. | Open |
| A3 | Medium | `app/app/api/lab/sponsor`, `app/app/api/private/ai`, `app/app/api/cron/crank` | No rate limit. Fresh wallets can drain the sponsor to its 0.02 SOL reserve; loops can run up AI charges. The cron secret uses a plain compare. | Bot check and per-IP limit; constant-time secret compare. | Open |

## Accepted risks

| # | Risk | Why it stays |
| --- | --- | --- |
| S3 | A caller chooses which Pyth update to pass, so they can pick the most favourable price from the last 60 s. | Bounded by the 2 % confidence cap and the 60 s window. Tightening it means changing `research.md` and its tests together. |
| S5 | Tokens donated to a vault flow through to the next payout. | Only the donor loses. |
| S6 | Any wallet can take a private `loan_id` first; `delegate_loan` is not bound to the creator. | Costs the squatter rent and blocks only that id. No funds move. |
| S7 | A room allows one loan, ever. | Product limit, not a fund risk. |
| S8 | `private_loan` has no undelegate path for loan or pool custody. | Parties use their own eSPL deposit and withdraw. The shared pool is covered by the S1 tests. |
| — | Pyth age inside the rollup uses the rollup clock and cloned account. | Gate 8.5 showed 0 s clone lag; a lagging clone fails closed with `StalePrice`. |
| — | A rollup outage can block repayment while expiry still runs. | Stated in `architecture.md`. |

## Upgrade keys

Both program keypairs live only in `isolated_loan/target/deploy/`. `cargo clean` would delete them and end the ability to upgrade. Keep a copy outside the repo.
