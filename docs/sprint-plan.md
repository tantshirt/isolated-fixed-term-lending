# Sprint plan

Seven days. Take the next open story in your lane. Leave week 2 alone until Epic 6 is done.

When a story is finished, change its status here from Open to Done and, if useful, add one line under Notes. Do not renumber stories.

## Program lane

| Order | Story | Day | Status |
| --- | --- | --- | --- |
| 1 | [1.1 Anchor project and offer account](stories.md) | 2 | Done |
| 2 | [2.1 Create and cancel](stories.md) | 3 | Done |
| 3 | [3.1 Repay](stories.md) | 4 | Done |
| 4 | [4.2 Integer value and LTV](stories.md) | 5 | Done |
| 5 | [6.1 Clean errors and a fresh run](stories.md) | 7 | Done |

## Oracle and client lane

| Order | Story | Day | Status |
| --- | --- | --- | --- |
| 1 | [1.2 Local mints and wallets](stories.md) | 2 | Done |
| 2 | [2.2 Accept](stories.md) | 3 | Done |
| 3 | [3.2 Claim expired](stories.md) | 4 | Done |
| 4 | [4.1 Price checks](stories.md) | 5 | Done |
| 5 | [4.3 Liquidate](stories.md) | 5 | Done |
| 6 | [5.1 Permission and double-settlement sweep](stories.md) | 6 | Done |
| 7 | [5.2 Three client scripts](stories.md) | 6 | Done |
| 8 | [6.1 Clean errors and a fresh run](stories.md) | 7 | Done |

Story 2.2, 4.2, 4.3, and 6.1 need both lanes in the same day. Whoever starts one should leave the other lane's half explicit in the pull request.

## Day rhythm

Day 1 is already spent in [research.md](research.md), [architecture.md](architecture.md), and [design-and-experience.md](design-and-experience.md). Do not reopen the formula unless a test proves it wrong. If it is wrong, fix the research note and the test together.

Days 2 through 7 follow the tables. At the end of each day, both lanes read the other's diff. The check is the same each time: seeds, signer, mint, and token account, plus the rounding direction.

## Week 2, not queued

| Story | Status |
| --- | --- |
| [7.1 Interface](stories.md) | Done |
| [7.2 Devnet, indexer, fuzz](stories.md) | Open |

## Private lane

MagicBlock private protocol on Devnet. Epic 8 is a gate: a later story starts only when the gate it depends on has passed in [magicblock-evidence.md](magicblock-evidence.md).

| Order | Story | Status |
| --- | --- | --- |
| 1 | [8.1 Pin the toolchain](stories.md) | Done |
| 2 | [9.1 Shared loan core](stories.md) | Done |
| 3 | [8.2 TEE auth and permissions](stories.md) | Done |
| 4 | [8.3 ER-only accounts](stories.md) | Done |
| 5 | [8.4 Program-controlled eSPL custody](stories.md) | Done |
| 6 | [8.5 Canonical Pyth inside the PER](stories.md) | Done |
| 7 | [8.6 Private scheduled execution](stories.md) | Done |
| 8 | [8.7 Commit visibility](stories.md) | Done |
| 9 | [9.2 Rooms, invitations, and scoped sessions](stories.md) | Done |
| 10 | [9.3 Private balances](stories.md) | Done |
| 11 | [9.4 Execution receipts and recovery](stories.md) | Done |
| 12 | [10.1 Fund, accept, repay, cancel, expire, withdraw](stories.md) | Done |
| 13 | [11.1 Discovery cards and competing proposals](stories.md) | Done |
| 14 | [11.2 AI request and callback](stories.md) | Done |
| 15 | [12.1 Expiry tasks and liquidation tickets](stories.md) | Done |
| 16 | [12.2 Magic Actions receipts](stories.md) | Done |
| 17 | [13.1 Transfers, sponsorship, lab, and accessibility](stories.md) | Done |

## Marketplace lane

Borrower-posted public requests and a top-level Discover page. Each story ships as its own pull request after a design council pass.

| Order | Story | Status |
| --- | --- | --- |
| 1 | [14.1 Borrower requests](stories.md) | Done |
| 2 | [14.2 Client and live reads](stories.md) | Done |
| 3 | [14.3 Discover page](stories.md) | Done |
| 4 | [14.4 Request a loan](stories.md) | Done |

## Notes

- Program and UI live under `isolated_loan/` and `app/`. Outcome scripts: `npm run script:repay|liquidate|expire` in `isolated_loan/`.
- Story 5.1 is covered by the LiteSVM suite in `isolated_loan/programs/isolated_loan/tests/litesvm.rs` (`npm run test:litesvm`).
- 2026-10-05: Devnet deployment and live repayment/cancellation/expiry/close checks completed; see [evidence](devnet-evidence.json). Story 7.2 remains Open because indexer and fuzz work are excluded from the approved Lendspan redesign.
- 2026-10-05: Story 9.1 done. Loan math and the Pyth check live in `isolated_loan/crates/loan-core`; the public program maps `CoreError` onto its own `LoanError` codes. Vectors in `crates/loan-core/vectors.json` are read by both the Rust and TS tests.
- 2026-10-05: Story 8.1 done. `private_loan` builds on ER SDK 0.17.3 with a gate-only `probe` module (create with permission, delegate to the TEE, write, Pyth check, commit and undelegate). Evidence in [magicblock-evidence.md](magicblock-evidence.md).
- 2026-10-05: Story 8.2 done on Devnet TEE; see [evidence](magicblock-evidence.md). The Rust SDK's `delegate_*` helper appends the PDA bump itself, so pass seeds without it. Use a full `anchor build`; `anchor build -p` writes to the program's own `target/`.
- 2026-10-05: Story 8.5 done on Devnet TEE; see [evidence](magicblock-evidence.md). Private accept and liquidate can use the same Pyth account and checks as the public program.
- 2026-10-05: Story 8.4 done on Devnet TEE; see [evidence](magicblock-evidence.md). Wallets cannot read custody token balances inside the TEE, so private loan state must carry its own accounting and the interface reads that, not token accounts.
- 2026-10-05: Epic 8 complete. 8.7 found that committed accounts are plaintext on Solana, so private loan records must be ER-only (8.3) and only balances and opaque receipts settle. 8.6 found no hosted cranker, so the worker runs one. Next: 9.2 rooms, invitations, and scoped sessions.
- 2026-10-05: Phase 1 done (9.2–9.4). `/devnet/private` is a guided workflow with TEE sign-in, rooms, private balance, and receipts; gate proof moved to `/devnet/private/proof`. Room threads are written in place because a 2.9 KB struct overflows the SBF stack.
- 2026-10-05: Phase 2 done (10.1). Private loans run inside the TEE between private balances; see evidence for the eATA-permission and base-ATA findings. The 10.1 acceptance line asking for the public LiteSVM vectors against `private_loan` is replaced by the shared `loan-core` vectors plus the Devnet run, because the ER instructions cannot run in LiteSVM.
- 2026-10-05: Phase 3 done (11.1, 11.2). The copilot runs as a Vercel Function through AI Gateway (budgeted key); no Docker or separate worker. The oracle pattern lives in `private_loan/src/ai.rs`, not a separate program, which saves a deployment.
- 2026-10-05: Phase 4 done (12.1 live expiry plus LiteSVM liquidation; 12.2 live receipt). Vercel Cron triggers the cranker every minute; its key and `CRON_SECRET` are Vercel env vars.
- 2026-10-06: Story 14.1 done. `LoanRequest` is a separate account, so existing Devnet offers keep deserializing; funding creates a normal filled `Offer`. The program grows from 368,160 to 476,952 bytes, so the Devnet upgrade needs `solana program extend` by about 109 KB first.
- 2026-10-06: Program upgraded on Devnet with the request instructions ([upgrade](https://explorer.solana.com/tx/3K5WSc7vQ6mPGEbohBxWxqsRmHcSkv5HZhtGVZCLBtxbtAFa1dqoz711ZUguWhtfE2jof2PkpohcuGppWrewsVJo?cluster=devnet)); program data extended by 110,000 bytes first. Story 14.2 done: `lib/requests.ts`, request senders in `lib/transactions.ts`, `lib/request-service.ts`, and `lib/client/live.ts` (account subscriptions with a slot heartbeat, polling fallback). Create, cancel and close were proven on Devnet ([evidence](devnet-request-evidence.json)); funding waits on a Hermes API key because public Hermes now returns 401.
- 2026-10-06: Epic 14 done (14.1–14.4). Discover at `/devnet/discover` with live public requests, offers and private cards; request wizard at `/devnet/discover/request`; council rulings in `.design-council/rulings.md`. Open item: set `PYTH_HERMES_API_KEY` so Devnet funding and acceptance can post a fresh price, then rerun `scripts/request-smoke.ts` to record a Devnet funding receipt.
