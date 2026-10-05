# MagicBlock evidence

One row per Epic 8 gate. A feature that depends on a gate stays off until the gate reads PASS. Raw signatures and RPC dumps go in `magicblock-evidence.json`.

| Gate | Status | Date | Evidence |
| --- | --- | --- | --- |
| 8.1 Toolchain | PASS | 2026-10-05 | `anchor build` (anchor-cli 1.0.2, anchor-lang 1.2.0 resolved, Rust 1.89) builds `isolated_loan` and `private_loan` with `ephemeral-rollups-sdk =0.17.3` (features `anchor`, `access-control`), zero warnings. `session-keys` 3.1.1 resolves and type-checks against anchor-lang 1.2.0. The SDK's Anchor-side `spl` module ships eSPL CPI builders, so no raw-instruction port is needed. |
| 8.2 TEE auth and permissions | PASS | 2026-10-05 | `spikes/gate-8-2.ts`. TDX attestation verified before any private call. Probe create, permission create, and both delegations land in one base transaction. The authority and the invited reader read the written value. An authenticated outsider and an anonymous caller get no account, an empty `getProgramAccounts`, no `accountSubscribe` events, and a transaction with no keys, data, balances, or logs. The base layer shows the account owned by the delegation program with the pre-delegation value. **Leak:** an outsider who knows a signature learns that it exists and succeeded. |
| 8.3 ER-only accounts | Not run | | |
| 8.4 eSPL custody | PASS | 2026-10-05 | `spikes/gate-8-4.ts`, for Devnet USDC (0.1) and wSOL (0.01). The custody PDA's eATA is funded and delegated in one base transaction. A PDA-signed SPL transfer inside the TEE moves 40% to a second custody. After undelegation, the base eATAs hold exactly 60/40, and both withdrawals return the wallet to its exact starting balance. Inside the TEE, neither the authority nor an outsider reads the true custody balance: the ATA reports a masked `0`. **Findings:** SDK 0.17.3's `spl` feature does not build for SBF, and its `WithdrawSplTokens` puts the owner sixth, while the deployed program reads it first. `private_loan/src/espl.rs` follows the program's processors instead. `spikes/recover-custody.ts` returns any stranded custody balance. |
| 8.5 Canonical Pyth in PER | PASS | 2026-10-05 | `spikes/gate-8-5.ts`. The PER copy of the shard-0 SOL/USD account (`7UVim…pjLiE`) keeps owner `rec5EK…`, and the shared `loan-core` check accepts it inside the TEE (stored price matches base). The canonical shard-1 account (`6bWEn…qfYgt`, about 30 days old) fails with `StalePrice`. MagicBlock's feed `ENYwe…4jPu` (owner `PriCems…`) fails with `InvalidPriceOwner`. Six samples showed 0 s of clone lag. **Not exercised:** a fresh base account with a lagging clone. The age check uses the ER clock against the clone's own publish time, so a lagging clone hits the same `StalePrice` path. |
| 8.6 Private scheduled execution | Not run | | |
| 8.7 Commit visibility | Not run | | |

## Pinned identities

- `private_loan` program id: `HwK4hxKqe94pLGkC9bGciENCCzvWwUAaz1mxVTDxMcK`. The keypair stays in `isolated_loan/target/deploy/` and is not committed, the same as `isolated_loan`.
- Every other id is in the Private protocol table in [architecture.md](architecture.md).
