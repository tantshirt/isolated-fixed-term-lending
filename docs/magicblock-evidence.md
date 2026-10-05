# MagicBlock evidence

One row per Epic 8 gate. A feature that depends on a gate stays off until the gate reads PASS. Raw signatures and RPC dumps go in `magicblock-evidence.json`.

| Gate | Status | Date | Evidence |
| --- | --- | --- | --- |
| 8.1 Toolchain | PASS | 2026-10-05 | `anchor build` (anchor-cli 1.0.2, anchor-lang 1.2.0 resolved, Rust 1.89) builds `isolated_loan` and `private_loan` with `ephemeral-rollups-sdk =0.17.3` (features `anchor`, `access-control`), zero warnings. `session-keys` 3.1.1 resolves and type-checks against anchor-lang 1.2.0. The SDK's Anchor-side `spl` module ships eSPL CPI builders, so no raw-instruction port is needed. |
| 8.2 TEE auth and permissions | Not run | | |
| 8.3 ER-only accounts | Not run | | |
| 8.4 eSPL custody | Not run | | |
| 8.5 Canonical Pyth in PER | Not run | | |
| 8.6 Private scheduled execution | Not run | | |
| 8.7 Commit visibility | Not run | | |

## Pinned identities

- `private_loan` program id: `HwK4hxKqe94pLGkC9bGciENCCzvWwUAaz1mxVTDxMcK`. The keypair stays in `isolated_loan/target/deploy/` and is not committed, the same as `isolated_loan`.
- Every other id is in the Private protocol table in [architecture.md](architecture.md).
