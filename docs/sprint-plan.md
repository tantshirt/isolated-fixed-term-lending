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
| 4 | [8.3 ER-only accounts](stories.md) | Open |
| 5 | [8.4 Program-controlled eSPL custody](stories.md) | Open |
| 6 | [8.5 Canonical Pyth inside the PER](stories.md) | Done |
| 7 | [8.6 Private scheduled execution](stories.md) | Open |
| 8 | [8.7 Commit visibility](stories.md) | Open |
| 9 | [9.2 Rooms, invitations, and scoped sessions](stories.md) | Open |
| 10 | [9.3 Private balances](stories.md) | Open |
| 11 | [9.4 Execution receipts and recovery](stories.md) | Open |
| 12 | [10.1 Fund, accept, repay, cancel, expire, withdraw](stories.md) | Open |
| 13 | [11.1 Discovery cards and competing proposals](stories.md) | Open |
| 14 | [11.2 AI request and callback](stories.md) | Open |
| 15 | [12.1 Expiry tasks and liquidation tickets](stories.md) | Open |
| 16 | [12.2 Magic Actions receipts](stories.md) | Open |
| 17 | [13.1 Transfers, sponsorship, lab, and accessibility](stories.md) | Open |

## Notes

- Program and UI live under `isolated_loan/` and `app/`. Outcome scripts: `npm run script:repay|liquidate|expire` in `isolated_loan/`.
- Story 5.1 is covered by the LiteSVM suite in `isolated_loan/programs/isolated_loan/tests/litesvm.rs` (`npm run test:litesvm`).
- 2026-10-05: Devnet deployment and live repayment/cancellation/expiry/close checks completed; see [evidence](devnet-evidence.json). Story 7.2 remains Open because indexer and fuzz work are excluded from the approved Lendspan redesign.
- 2026-10-05: Story 9.1 done. Loan math and the Pyth check live in `isolated_loan/crates/loan-core`; the public program maps `CoreError` onto its own `LoanError` codes. Vectors in `crates/loan-core/vectors.json` are read by both the Rust and TS tests.
- 2026-10-05: Story 8.1 done. `private_loan` builds on ER SDK 0.17.3 with a gate-only `probe` module (create with permission, delegate to the TEE, write, Pyth check, commit and undelegate). Evidence in [magicblock-evidence.md](magicblock-evidence.md).
- 2026-10-05: Story 8.2 done on Devnet TEE; see [evidence](magicblock-evidence.md). The Rust SDK's `delegate_*` helper appends the PDA bump itself, so pass seeds without it. Use a full `anchor build`; `anchor build -p` writes to the program's own `target/`.
- 2026-10-05: Story 8.5 done on Devnet TEE; see [evidence](magicblock-evidence.md). Private accept and liquidate can use the same Pyth account and checks as the public program.
