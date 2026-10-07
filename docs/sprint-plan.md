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

## ZenLo lane

The rebrand and the returning-user experience. Each phase ships as its own pull request after a design council pass.

| Order | Story | Status |
| --- | --- | --- |
| 1 | [15.1 Brand foundation](stories.md) | Done |
| 2 | [15.2 Abstract art set](stories.md) | Done |
| 3 | [15.3 Landing and use cases](stories.md) | Done |
| 4 | [15.4 App restyle without Sharky](stories.md) | Done |
| 5 | [16.1 Per-wallet reads](stories.md) | Done |
| 6 | [16.2 My loans page](stories.md) | Done |
| 7 | [16.3 Returning wallets](stories.md) | Done |
| 8 | [17.1 Finding your rooms](stories.md) | Done |
| 9 | [17.2 Owners and requests to join](stories.md) | Done |
| 10 | [17.3 Loans and bids that stay visible](stories.md) | Done |
| 11 | [18.1 Both sides, end to end](stories.md) | Done |

## Desk lane

The desk-first roadmap, Stages 0–4. One pull request per row, built, reviewed by the design council and merged before the next row in the same track starts. The foundation, accounting and governance tracks can run side by side; the Depends column says what must be merged first. Stage 5 (Epic 25) starts only when every row here is Done.

| Order | Story | Depends on | Status |
| --- | --- | --- | --- |
| 1 | [19.1 Lender pilot kit](stories.md) | — | Done |
| 2 | [19.2 Convex and wallet sign-in](stories.md) | — | Open (code done; hosted Convex waits on Marketplace terms) |
| 3 | [19.3 Durable jobs, capabilities and operations](stories.md) and [19.4 Versioned models](stories.md) | 19.2 | Open (code done; cutover after 7 clean days on hosted Convex; screens adopt `LoanView` as V2 lands) |
| 4 | [19.5 Governance](stories.md) and [19.6 Asset registry](stories.md) | — | 19.6 Done; 19.5 Open (time-locked executions due 2026-10-08, independent signers, V2 deploys under the vault) |
| 5 | [20.1 Accounting engine](stories.md), [20.2 Pricing ceilings](stories.md), [20.3 Spot and EMA](stories.md) | — | Done |
| 6 | [21.1 `isolated_loan_v2` core](stories.md) | 19.5, 20.x | Done |
| 7 | [21.2 Grace, recovery and surplus](stories.md) and [21.3 Reference liquidator](stories.md) | 21.1 | Open (code and tests done; Devnet evidence as fixture windows open, 2026-10-08 to 2026-10-15) |
| 8 | [22.1 Multi-loan rooms](stories.md) | 19.5 | Done (Devnet TEE proof in `docs/magicblock-evidence.json` under `v2`) |
| 9 | [22.2 Private V2 protections](stories.md) | 20.x, 22.1 | Done (program and LiteSVM in row 8; browser client proven live in `docs/magicblock-evidence.json` under `v2Client`) |
| 10 | [23.1 Desk accounts, roles and policies](stories.md) | 22.2 | Done (Devnet TEE proof in `docs/magicblock-evidence.json` under `v2`) |
| 11 | [23.2 Desk workspace](stories.md) | 23.1 | Open (workspace, desk actions and view-model tests done; member screens proven live once `private_loan_v2` is deployed) |
| 12 | [24.1 Auditor consent](stories.md) and [24.2 Private portfolios](stories.md) | 23.1 | Done (auditors shown and verified by hash before signing, consent bound on-chain, reader removal; V1 and V2 private totals in My loans) |
| 13 | [24.3 Alerts and reminders](stories.md) | 19.3, 22.2 | Open (built and proven on local Convex; needs a Telegram bot token and hosted Convex) |
| 14 | [24.4 MoneyGram cash-out](stories.md) and [24.5 Gate metrics](stories.md) | 19.3, 24.2 | Open (built and checked locally; needs MoneyGram sandbox keys, an allowlisted domain and hosted Convex) |
| 15 | [19.7 Honest shipped-feature surfaces](stories.md) | 19.6 | Done (landing, use cases and six official logos; badges derived from Devnet evidence and provider flags) |
| 16 | Provider cutover: hosted Convex, Telegram, MoneyGram sandbox, independent Squads signers (closes rows 2, 3, 4, 13, 14) | owner keys | Open (waiting on keys) |
| 17 | [26.2 Per-asset collateral and jitoSOL](stories.md) | 19.5, 20.3 | Open (code and tests done; Devnet config write waits on a Squads proposal and the 24-hour time lock) |
| 18 | [26.1 Refinance and rollover](stories.md) | 26.2 | Open |
| 19 | [26.3 Automation mandates](stories.md) and [26.4 Private liquidation operations](stories.md) | 26.1, 26.2 | Open |
| 20 | [26.5 MoneyGram cash-in](stories.md) | row 16 | Open |
| 21 | [26.6 Shielded deposits and withdrawals](stories.md) | — | Open (spike first) |
| 22 | [26.7 Credit](stories.md) | 26.2, 26.3 | Open |
| 23 | [26.8 Secondary market and activity export](stories.md) | 26.1, 26.3 | Open |
| 24 | [27.1 Arcium credit computation](stories.md) | 26.7 | Open (lifts the Arcium ban in AGENTS.md in the same PR) |

2026-10-07: the owner waived the Epic 25 customer gate and pulled Epic 26 and the Arcium part of Epic 27 forward. 25.1 still runs as a pilot in parallel; it no longer blocks rows 16–24.

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
- 2026-10-06: Epic 14 done (14.1–14.4). Discover at `/devnet/discover` with live public requests, offers and private cards; request wizard at `/devnet/discover/request`; council rulings in `.design-council/rulings.md`. Devnet funding proven the same day once `PYTH_HERMES_API_KEY` was set ([evidence](devnet-request-evidence.json)); the key must also be set in the deployment environment.

- 2026-10-06 ZenLo phase 1: tokens, Nunito, pebble-and-wave mark, icons and share image, display name. Story 15.2 art ships with 15.3 in the landing pull request.
- 2026-10-06 ZenLo complete: rebrand (15), My loans (16), rooms and invites without a program change (17), and a 12-check Devnet cycle (18).
- 2026-10-06: Security audit ([report](security-audit.md)). Fixed S1, S2, S4 on chain and A1–A3 in the app. The fuzz part of story 7.2 is done (`npm run test:fuzz`, 2,000 cases by default, plus a 50,000-case run); 7.2 stays Open for the indexer. CI added in `.github/workflows/ci.yml`.
- 2026-10-07: Desk-first roadmap queued (Epics 19–27). The week-1 limits on per-second interest, partial repayment, top-up, refinance and Devnet work now apply to the legacy programs only; V2 follows the updated research note.
- 2026-10-07: Story 19.1 done. Pilot kit in `docs/pilot/`; `app/lib/pilot/gate.ts` evaluates the measurable gate checks and excludes `developer-wallets.json`.
- 2026-10-07: Story 19.2 code done and proven against a local Convex deployment (`app/scripts/auth-e2e.mjs`, 9 checks). See [backend.md](backend.md). Stays Open until the hosted Convex deployments are connected through the Vercel Marketplace.
- 2026-10-07: Stories 19.3 and 19.4 code done. Proven on a local Convex: dedup, retry then success, permanent failure, crash-after-send → uncertain → reconciled → retried → succeeded, shadow scan of live Devnet watches, live-report parity, and `/ops/health`. My loans now reads `LoanView`.
- 2026-10-07: Story 19.6 done (`app/public/brands/registry.json`, hash-checked by a test). Story 19.5: Squads 2-of-3 with a 24-hour time lock on Devnet. Threshold and time-lock refusals are recorded in [governance.md](governance.md), and the `governance` crate separates the V2 roles.
- 2026-10-07: Story 20.1 done. `loan-core::accounting` and `app/lib/loan-math-v2.ts` agree on `vectors-v2.json` (7 cases, 29 steps). 200,000 property cases pass. A property test caught the late fee taking the ceiling room before the maturity round-up; the round-up now happens first, and research.md says so.
- 2026-10-07: `isolated_loan_v2` program written with all V2 instructions, including the 21.2 recovery paths, so Devnet gets one deploy. 16 LiteSVM tests; the legacy suites pass unchanged. 427 KB at `opt-level = "z"`.
- 2026-10-07: `isolated_loan_v2` deployed to Devnet; the upgrade authority is the Squads vault. Five fixtures opened plus one adopted; late-repay and top-up proven live. Client, wizards, loan and request pages, lists, the Learn simulator and the reference liquidator are built. The V1 demo is unchanged for V1 loans, and the V2 rules have their own wallet-free simulator on /learn. The app creates V2 loans when `NEXT_PUBLIC_V2_LIVE=1`.
- 2026-10-07: `private_loan_v2` written: Config authorities, creator-namespaced rooms and loans, role bits with no owner bypass, 16 members, room index registry, one deal per request, V2 ledger (partial repay, top-up, priced and terminal claims), and a spot-and-EMA watch with stale-quote invalidation and excess refunds. 836 KB. 10 unit and 7 LiteSVM tests pass.
- 2026-10-07: Desks and auditor consent are in `private_loan_v2` before its first deploy, so one deploy covers rows 8–12. 931 KB. 15 unit and 7 LiteSVM tests pass.
- 2026-10-07: Private V2 codec (`app/lib/private/v2-codec.ts`) proven byte-for-byte against a Rust fixture. My loans names public and private totals separately; private totals read "Locked" until private sign-in, and private borrowing is listed.
- 2026-10-07: Story 24.3 built: band engine with hysteresis and rebasing, deadline and window reminders, consented subscriptions, one-use Telegram links, secret-checked webhook, deduplicated sends. Private loans share deadlines only and get generic text.
- 2026-10-07: Story 24.4 built from the official Ramps docs (server sessions, hosted widget, reviewed transferChecked, Ed25519 webhook with (id, status) dedup, `status?sync=true` reconciliation, fallback poll, stuck-session monitor). Story 24.5: opt-in pilot events and an ops-only gate report.
