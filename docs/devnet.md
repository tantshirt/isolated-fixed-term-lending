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
