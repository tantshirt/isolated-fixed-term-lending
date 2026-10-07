# Devnet foundation

The frontend defaults to Solana Devnet, canonical test USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, and native wrapped SOL `So11111111111111111111111111111111111111112`. Read-only offer access needs no wallet. The existing lending program and all arithmetic are unchanged.

## Configure and verify

Copy `app/.env.example` to `app/.env.local`, keeping credentials out of git. Set `NEXT_PUBLIC_LOAN_PROGRAM_ID` to the deployed program address. Program construction, IDL address overrides, PDAs, wallet RPC and storage namespaces all share these values. Public environment variables are compiled into the browser bundle; rebuild after changing them. Never put RPC credentials in public configuration.

By default the server derives the SOL/USD shard-0 account. Optionally set `PYTH_PRICE_UPDATE_ACCOUNT` to the legacy-compatible Pyth receiver's SOL/USD shard-0 account. Derive it from the installed SDK without transactions:

```sh
cd app
node -e 'const {getPriceFeedAccountForProgram,DEFAULT_PUSH_ORACLE_PROGRAM_ID}=require("@pythnetwork/pyth-solana-receiver"); console.log(getPriceFeedAccountForProgram(0,"ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",DEFAULT_PUSH_ORACLE_PROGRAM_ID).toBase58())'
npm test
npx tsc --noEmit
npm run dev
```

`GET /api/config` returns the existing config plus `network`, `programId`, `rpcUrl`, `localControls`, and `readiness: { ready, errors }`. Readiness requires an executable loan program and a Full-verified fresh price account with correct owner/feed/confidence/exponent. An unavailable chain clock or RPC is a failure, not an invented price or empty loan list. `GET /api/price` never restamps Devnet prices.

The optional `PYTH_HERMES_API_KEY` and `PYTH_HERMES_URL` stay on the server. `/api/pyth-update` fetches only the SOL/USD signed binary update, never sends a transaction, and never returns upstream credentials or raw upstream error text. The installed Pyth SDK uses the original receiver `rec5EK…` expected by the deployed loan program. Do not switch to the separate `rec2…` contracts without a reviewed protocol change. Both current Pyth documentation and the installed SDK document the compatible deployment: https://docs.pyth.network/price-feeds/core/contract-addresses/solana and https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/solana.

## Deployment and smoke procedure

The primary agent must verify the concrete cluster, program key, binary and payer balance before deploying. These commands are the reproducible procedure, not evidence that deployment occurred:

Always deploy the default build. A `local-mints` build accepts any mint and must never reach Devnet. `npm run test:litesvm` rebuilds without it and fails if mints are not pinned, so run it right before deploying.

```sh
cd isolated_loan
NO_DNA=1 npm run test:litesvm
solana program show --url devnet CKvMgaAJmtoUN73wDxAKvjYs2d5fcirttjjEjrV9hnef
solana balance --url devnet
# After target/resources verification, using the already-configured CLI signer:
solana program deploy --url devnet --program-id target/deploy/isolated_loan-keypair.json target/deploy/isolated_loan.so
NO_DNA=1 npm run test:litesvm
```

Never print or copy the deploy keypair contents. After deployment, verify `/api/config` readiness, read offers with the wallet disconnected, connect a Devnet wallet funded with test SOL and canonical faucet USDC, explicitly wrap the required collateral, create a small offer, accept from another wallet, and repay. Verify each signature on Devnet Explorer. For expiry use a short valid term and wait for real chain time; there is no Devnet time-travel route. Test invalid oracle and authority scenarios locally with the unchanged LiteSVM suite.

## Frontend integration contract

- `constants.ts`: `NETWORK`, `IS_LOCAL`, `RPC_URL`, `PROGRAM_ID`, canonical mint constants. Hide the local desk when `localControls` is false.
- `useDevConfig()` adds `readiness`; retain the existing config shape. `useOffer()` adds `error`. A read error must be shown as unavailable rather than closed. `useBalances()` returns null on read failure, never fabricated zero balances.
- Existing `sendCreateOffer`, accept/repay/cancel/claim/liquidate/close signatures remain compatible. All simulate before wallet signing, confirm, and return signatures.
- `sendWrapSol(signer, additionalLamports)` is an explicit action; it creates an idempotent native ATA, transfers SOL and syncs native balance, retaining rent and 0.01 SOL for fees. Do not invoke it silently from acceptance.
- `sendPythUpdate(signer)` from `lib/pyth.ts` explicitly posts a Full-verified update to shard 0 and returns `{ priceUpdateAccount, signatures }`. This may request several wallet signatures and spend SOL on fees/temporary rent. Reinvoke after an interrupted batch to resume within the same page session. Configure that shard-0 account for the read API. Persistent submission reconciliation still protects a pending signature after reload; a reloaded Pyth batch may need a fresh posting and rent recovery for abandoned temporary accounts.
- `SubmissionError` has `state` (`rejected`, `simulation-failed`, `confirmed-failure`, `uncertain`) and optional `signature`. Display `signatureUrl(signature)` when present. Uncertain submissions are stored per network/program/wallet before broadcast; every later submission reconciles that signature first. Never clear this storage or tell the user to submit again blindly. A transaction is eligible for replacement only after no status exists and finalized block height exceeds its validity window.

For local development explicitly set `NEXT_PUBLIC_SOLANA_NETWORK=localnet`, loopback `NEXT_PUBLIC_SOLANA_RPC_URL`, and `ENABLE_LOCAL_CONTROLS=true`. Local controls also require a nonproduction server and loopback request host, rejecting foreign browser origins. Production always disables them, including when localnet was mistakenly configured. Demo signer material is never restored on Devnet.

For RPC providers with a distinct WebSocket path, set `NEXT_PUBLIC_SOLANA_WS_URL`. For example, OnFinality HTTPS uses `https://solana-devnet.api.onfinality.io/public` and WebSockets use `wss://solana-devnet.api.onfinality.io/public-ws`. `getConnection()` (also used by `getProgram()`) passes the explicit WebSocket endpoint. Frontend wallet `ConnectionProvider` must likewise pass `config={{ wsEndpoint: WS_URL }}` with `WS_URL` from `lib/constants`; `/api/config` exposes `wsUrl` (null when omitted). Leave it unset for the default official endpoint.

## Verified deployment — 5 October 2026

Program `CKvMgaAJmtoUN73wDxAKvjYs2d5fcirttjjEjrV9hnef` is deployed and executable on Devnet. [Deployment transaction](https://explorer.solana.com/tx/FkC5xQ7K4b2b5qWK2jyd2Zkaqc1MqcbCjdQSf53Bxr2UEvcE1dMZBWNh6briRUXcDbQyhdKPA1QoyiJiz78qN3q?cluster=devnet).

The live script verified creation, acceptance, repayment, cancellation, real-time expiry, and closing each settled offer using 0.10 canonical test-USDC principal. [Recorded receipts](devnet-evidence.json) contain the transaction links. These are client-script checks against the deployed program; they do not claim browser-extension signing was automated. Liquidation is covered by the simulation and local program tests, not a forced Devnet price change.

The first run crashed under public RPC rate limiting. Its temporary borrower's memory-only key was lost, leaving 0.045383514 test SOL, 0.003113046 wSOL, and account rent unrecovered. No principal remains in an open loan. The recovery run completed expiry and closed its token accounts, returning its remaining funds and verifying zero SOL balance. The updated smoke script paces requests, uses HTTP confirmation, and attempts cleanup in `finally`; an abrupt process termination can still lose an ephemeral key.

Public RPC availability varies. A pending submission is not evidence of failure; reconcile the recorded signature before repeating an action.

## Borrower requests upgrade — 6 October 2026

The same program was upgraded in place with `create_request`, `cancel_request`, `fund_request` and `close_request` ([upgrade transaction](https://explorer.solana.com/tx/3K5WSc7vQ6mPGEbohBxWxqsRmHcSkv5HZhtGVZCLBtxbtAFa1dqoz711ZUguWhtfE2jof2PkpohcuGppWrewsVJo?cluster=devnet)). The new binary is 476,952 bytes against 368,160 deployed, so program data was first extended by 110,000 bytes:

```sh
solana program extend CKvMgaAJmtoUN73wDxAKvjYs2d5fcirttjjEjrV9hnef 110000 -u devnet
solana program deploy -u devnet --program-id target/deploy/isolated_loan-keypair.json target/deploy/isolated_loan.so
```

The `Offer` layout did not change, so existing offers still read. `scripts/request-smoke.ts` (run with `npx tsx --env-file=.env.local scripts/request-smoke.ts --run`) proved the whole request lifecycle on Devnet: create, cancel and close; then create, a fresh Pyth post, fund, repay, close the offer and close the request. Receipts are in [devnet-request-evidence.json](devnet-request-evidence.json). Public Hermes now returns 401 without `PYTH_HERMES_API_KEY`; set it in `app/.env.local` and in the deployment environment, because `/api/pyth-update` needs it for in-app funding and acceptance.

## Security upgrade — 6 October 2026

Both programs were upgraded in place with the audit fixes ([security-audit.md](security-audit.md)): pinned USDC and wSOL mints (S2), reusable liquidation ticket slots with permissionless refunds (S1), and the price-account check in `schedule_watch` (S4).

- `isolated_loan`: [upgrade](https://explorer.solana.com/tx/58dQXjEb3nHGMkWfsoKd393KHWTSE1Ki7Zcd1gQDbYDTJecGgLAUZUzgQf3W2Q4vDUucGizCqnaBCgXMKZHWZr6m?cluster=devnet). The CLI extended program data to 488,400 bytes itself; a manual `program extend` must request at least 10,240 bytes.
- `private_loan`: [upgrade](https://explorer.solana.com/tx/3HisAApfzjauNYWm6Bb3HpQrMjEPUQsXTvr32b3SKAwVpaH8pCq7FvcJeQCDbZZabHY56Q3u3ZhAoKGBVKkiTJCX?cluster=devnet).
- Both on-chain binaries were dumped and match the local pinned build byte for byte (`isolated_loan.so` sha256 `d11e88e1…`, `private_loan.so` sha256 `fa41fb36…`).
- `scripts/request-smoke.ts` passed afterwards: create, cancel, fund, repay and close with canonical USDC and wSOL ([evidence](devnet-request-evidence.json)).
- A simulated `create_offer` with SPL USDC-Dev (`Gh9Zw…tKJr`, 6 decimals) fails with `MintNotAllowed` (6022); the same call with canonical USDC simulates cleanly.

## Repayment-rules program (`isolated_loan_v2`)

- Program `8hxagcQkw1Km6PWZgpA92qUnqvnFufC7tx2jvxf9Ko8m`, deployed 2026-10-07 with `--max-len 520000` (about 93 KB of headroom over the 427 KB build).
- Upgrade authority: the Squads vault `8MpmERed9K14R68F371YJtGVk6mQgNZoQeU3asNPs5mt` ([governance.md](governance.md)). Upgrades go through `scripts/governance/squads.ts propose-upgrade` with two approvals and the 24-hour time lock.
- The app creates new offers and requests on V2 only when `NEXT_PUBLIC_V2_LIVE=1`. V1 loans keep their original pages, codec and program.

### Long-duration fixtures

`app/scripts/v2-fixtures.ts` opened six real 1-USDC loans: 60-second terms, 24-hour grace, 400% test ceiling. Evidence is in [v2-fixtures.json](v2-fixtures.json). The seven-day window is never shortened.

| Fixture | Proven so far | Next step and when (UTC) |
| --- | --- | --- |
| late-repay | Repaid in grace, paying 1,010,966 atoms. The late fee was clamped to 966 by the ceiling. | Done |
| top-up | 0.005 wSOL added, then repaid early at exactly the 25% minimum (1,002,500 atoms) | Done |
| overdue | Live | `step overdue` after 2026-10-08 08:28 |
| keeper | Live | The reference liquidator settles it on its own after 2026-10-08 08:28 (`scripts/keeper-once.ts --run`, or the Convex cron) |
| priced | Live | `step priced` after 2026-10-09 08:27 |
| terminal | Live | `step terminal` after 2026-10-15 08:26 |

Run each step with `npx tsx --env-file=.env.local scripts/v2-fixtures.ts --run step <name>`. `--run status` prints each loan's phase and payoff.

### Reference liquidator

`lib/v2/keeper.ts` settles V2 loans that anyone may settle: risk liquidation past the spot-and-EMA line, or overdue after grace. It uses only the operator's own Devnet USDC.

- **Limits**: 50 USDC per action, 200 USDC per 24 hours, and at least 1% more collateral value received than USDC paid.
- **Before sending**: it re-reads the loan and the price, simulates the transaction, and records the signature before confirming.
- **In Convex**: it runs every minute when `KEEPER_ENABLED=1` and `KEEPER_SECRET` are set on the deployment. Capital, settlements, failures and depletion appear in `/ops/health`.
- **No guarantee**: it never promises to act. Any wallet can settle the same loans.

## Umbra wSOL shielding (Story 26.6)

Spike, 7 October 2026:

- **Umbra**: Devnet program `DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ`. The relayer (`https://relayer.api-devnet.umbraprivacy.com/v1/relayer/info`) lists wSOL `So11111111111111111111111111111111111111112` but not ZenLo's Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Umbra's docs say Devnet and localnet support wSOL only.
- **Privacy Cash**: blocked. There is no public Devnet relayer, and the official SDK is mainnet-only.

The app uses `@umbra-privacy/sdk` 4.0.0 (pinned exact). It covers direct deposits into an encrypted balance and withdrawals back to the wallet, decrypts the balance locally and signs through Wallet Standard, so it needs no ZK prover. `app/lib/umbra/session.ts` is the only module that imports it. The My loans panel loads that module on first use.

What it does:

- **Shield / Unshield wSOL**: moves wSOL between the wallet's token account and the Umbra encrypted balance. It is a wallet step before a deposit or after a withdrawal. ZenLo's loan mints and programs are unchanged.
- **Visible on chain**: the amount, the time and the wallet address of each shield and unshield. Only the balance held in between is hidden.
- **Keys**: one wallet signature over Umbra's consent message derives the master seed. The SDK keeps it in memory, so closing the tab forgets it. Nothing is written to localStorage, IndexedDB, Convex, telemetry, exports or notifications. `app/lib/umbra/key-leak.test.ts` enforces this.
- **Recover shielded balance**: discards the session, asks the same wallet to sign again (which gives the same keys), and re-reads the encrypted balance from Devnet.
- **Switch**: `NEXT_PUBLIC_UMBRA_ENABLED=1`. Leave it off until the recovery test below has passed and been recorded.

### Manual recovery test (needs a real wallet)

Run this with Phantom, Backpack or Solflare set to Devnet, holding about 0.2 SOL and at least 0.05 wSOL:

1. Build with `NEXT_PUBLIC_UMBRA_ENABLED=1` and open `/devnet/me`. Connect the wallet.
2. Choose **Unlock with wallet signature** and sign Umbra's consent message. Write down the shielded balance (usually 0).
3. Shield 0.05 wSOL. Approve the registration transactions (first time only) and the deposit. Record the queue signature from the wallet history. Check that the shielded balance went up by 0.05 minus Umbra's fee.
4. Clear the site's storage (DevTools → Application → Clear site data) and reload. The panel should show the shielded balance as Hidden.
5. Choose **Recover shielded balance** and sign again. The balance from step 3 should come back.
6. Unshield the full shielded amount. Check that the wallet's wSOL went up and the shielded balance is 0.
7. Fill in the `umbra` entry in [shield-evidence.json](shield-evidence.json) with the wallet, the signatures and the balances seen. Then set `NEXT_PUBLIC_UMBRA_ENABLED=1` on the deployment.

If step 3 or 6 reports that Umbra's confirmation is pending, wait a minute and choose Recover. If tokens stay staged after a dropped callback, use Umbra's `getStagedSolRecovererFunction`; the UI does not offer that yet.
### jitoSOL (test) collateral

Story 26.2. On Devnet the second collateral is a ZenLo-made 9-decimal mint labelled "jitoSOL (test)". The real JITOSOL/USD feed (`67be9f51…de019ffb`) prices it, with its own caps: 60% max LTV and 70% liquidation LTV. It is not real jitoSOL, and the app shows it as a text label with no logo.

1. **Create the mint (once).** From `app/`, run `npx tsx scripts/jitosol-test-mint.ts create`. The Solana CLI default keypair pays and holds the mint authority. The address is saved in `isolated_loan/.local/jitosol-test-mint.json`. The script prints the mint, its `CollateralConfig` PDA (`["collateral", mint]` under `isolated_loan_v2`) and the governance arguments.
2. **Write the CollateralConfig through Squads.** Only `authorities.governance` (the Squads vault) may call `set_collateral_config` for the test mint with `feed_id` = JITOSOL/USD, `max_ltv_bps` = 6000, `liquidation_ltv_bps` = 7000 and `enabled` = true. That call needs a Squads proposal with two approvals and the time lock ([governance.md](governance.md)). **No jitoSOL loan works on Devnet until the proposal executes.** Until then, every create, accept, fund, liquidation and priced recovery fails with `CollateralNotConfigured`.
3. **Fund a test wallet.** `npx tsx scripts/jitosol-test-mint.ts mint --to <wallet> --amount 5` mints 5 test tokens to the wallet's associated token account.
4. **Turn it on in the app.** Set `NEXT_PUBLIC_JITOSOL_ENABLED=1` and `NEXT_PUBLIC_JITOSOL_MINT=<mint>`, with `NEXT_PUBLIC_V2_LIVE=1`. The public V2 Create offer and borrow Request wizards then show a collateral picker: wSOL or jitoSOL (test). With the flag off, the picker is hidden and nothing changes. With the mint set and the flag off, existing jitoSOL loans can still be serviced.

**How the app signs jitoSOL transactions.** Create, accept, fund, both liquidations and priced recovery pass the `CollateralConfig` PDA as the first remaining account. Before accept, fund, either liquidation or priced recovery, the app writes a fresh JITOSOL/USD Hermes update to the feed's Pyth push account (shard 0) through the Pyth receiver. The loan instruction runs right after the write, in the same transaction when it fits. Borrowers and lenders never need a separate "post a price" step. The terminal claim, repay and add collateral read no price and pass no config. The reference liquidator skips jitoSOL loans for now (`unsupported-collateral`), and any other wallet can settle them.
