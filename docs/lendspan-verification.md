# Lendspan verification

## Reproduce

```sh
cd app
npm ci
cp .env.example .env.local
npm test
npm run lint
npx tsc --noEmit
NEXT_BUILD_DIR=.next-review npm run build
NEXT_BUILD_DIR=.next-review npm start -- --port 3003
```

Use a local Playwright installation for the browser journey:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/browser-check.mjs
```

The script checks landing and demo isolation from chain APIs, all four settlement/cancellation outcomes, invalid actor and deadline errors, reload and corrupted storage, deep links, validation, keyboard focus, disabled browser storage, and layouts at 390, 768, and 1440 pixels. Screenshots are written to `/private/tmp` during this macOS review. Set `BROWSER_BASE_URL` for another preview port.

## Evidence and limits

The program was rebuilt and deployed to Devnet. Live client scripts verified create, accept, repay, cancel, expiry, and close using 0.10 canonical test USDC. See [Devnet receipts and limitations](devnet.md#verified-deployment--5-october-2026), including test funds left in the first interrupted temporary wallet. No mainnet transactions were made. Liquidation remains a deterministic simulation and local-program test rather than a forced Devnet price event.

Three review lenses covered correctness, edge cases, and missing verification. The resulting fixes include stable creation identity across uncertain retries, cross-tab submission coordination, pending-signature validation, canonical mint filtering, matching Pyth read/update targets, real-chain time independent of oracle availability, storage-independent demo navigation, and retained transaction receipts. The runtime limited fresh reviewer threads; the edge reviewer reused the backend agent to inspect independently authored UI surfaces.

Browser-extension wallet signing and wallet-funded Pyth posting were not automated in the browser suite. Public RPC rate limits remain an external availability constraint. The Pyth SDK retains its upstream Anchor version dependency warnings during bundling.

## Final result

On 5 October 2026: all 36 unit tests passed; ESLint, TypeScript, production build, and the full browser journey passed. Screenshots were visually inspected on desktop and mobile. All review findings were addressed; no application defects were deferred. The preview runs locally at `http://localhost:3003`.
