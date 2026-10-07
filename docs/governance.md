# Governance

V2 programs are governed by a Squads v4 multisig on Devnet. The legacy programs keep their current upgrade key, so legacy loans are serviced exactly as before.

| Item | Value |
| --- | --- |
| Squads program | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` |
| Multisig | `9aAiYToZ4ZrHMcyAoNDDnMiswobn3TxtJ1dGXgKkBkU5` |
| Vault (index 0) | `8MpmERed9K14R68F371YJtGVk6mQgNZoQeU3asNPs5mt` |
| Threshold | 2 of 3 |
| Time lock | 86,400 seconds (24 hours) |
| Config authority | none, so membership and threshold change only through a voted, time-locked proposal |

Evidence for every step is in [governance-evidence.json](governance-evidence.json), and the script is `isolated_loan/scripts/governance/squads.ts`.

## Signers are a rehearsal

All three signers are currently held on the developer's machine: `a` is the deployer key, and `b` and `c` are generated rehearsal keys. **That is not independent custody.** Before any external pilot, rotate two members to keys held by two other people, using the rotation procedure below. Until then, governance is a rehearsal of the procedure, not a control.

## V2 authorities

The `governance` crate (`isolated_loan/crates/governance`) defines the `Authorities` that each V2 program stores in its `Config` account:

| Role | Can do | Cannot do |
| --- | --- | --- |
| governance (Squads vault) | rotate every key, change financial policy, upgrade the program | — |
| AI admin | register and replace the AI worker | change caps or fees, rotate anyone |
| AI worker | answer AI requests | anything financial |
| liquidation-pool admin | administer liquidation-ticket parameters | rotate keys, change loan policy |
| credential issuer | issue credentials (later epics) | anything financial |
| keeper | trigger scheduled settlement checks | anything financial |

Every key must be set and no two roles may share a key. Unit tests reject the legacy pattern where `AI_ADMIN` also ran the liquidation pool. `rotate` and `require_policy` accept only governance. The V2 programs call these checks; there is no single-key bypass.

Each V2 program is deployed with the vault as its upgrade authority. Upgrades are proposed with `propose-upgrade --program <id> --buffer <buffer>`: the buffer is written with the deployer key, authority is set to the vault, and two approvals plus the time lock are required before execution.

## Enforcement already proven on Devnet (2026-10-07)

| Check | Result |
| --- | --- |
| Vault transfer with one approval, executed | Refused: `InvalidProposalStatus` (6008) |
| The same transfer with two approvals, executed immediately | Refused: `TimeLockNotReleased` (6021) |
| Member rotation (remove `b`, add `d`) with two approvals, executed immediately | Refused: `TimeLockNotReleased` (6021) |

## Waiting on the time lock

Both proposals become executable after about 2026-10-08 08:00 UTC. Run:

```
cd isolated_loan
npx tsx scripts/governance/squads.ts execute --index 1 --signer a   # time-locked vault spend
npx tsx scripts/governance/squads.ts execute --index 2 --signer a   # rotation: b out, d in
npx tsx scripts/governance/squads.ts status
```

The rotation doubles as the recovery rehearsal. Treat `b` as a lost key: the remaining members `a` and `c` remove it and add a replacement, without `b` signing again.

## Recovery procedure

1. Any remaining member creates a rotation proposal: `propose-rotate --remove <lost key> --add <new key>`.
2. Two remaining members approve it.
3. After 24 hours, any member executes it.
4. Losing two keys at once is unrecoverable by design. Keep each signer on a separate device and person.
