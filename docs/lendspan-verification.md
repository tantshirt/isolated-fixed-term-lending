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

### Wallet and asset polish — 5 October 2026

Official SOL, USDC, Phantom, Backpack, Jupiter, and MetaMask artwork now appears in funding, wallet selection, account balances, and loan forms. Artwork provenance is recorded in [brand sources](../app/public/brands/SOURCES.md). The protocol remains USDC/wSOL.

Wallet choices distinguish detected adapters from installation links and check declared network/signing capabilities. MetaMask uses its official Connect Solana SDK, registered lazily after desktop extension detection without requesting accounts. Its Devnet path is desktop-extension-only; mobile users see an installation option. See the [MetaMask Solana integration guide](https://docs.metamask.io/metamask-connect/solana/).

All 38 unit tests pass. Browser checks cover official image loading, install links, mobile layout, focus restoration, precise large amounts, and Wallet Standard connection, rejection, retry, and switching for all four brands. These use controlled wallet fixtures, not installed extension signing; no transactions were signed during this polish pass. The full demo regression suite also passes. Run the additional suite with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright BROWSER_BASE_URL=http://localhost:3004 node scripts/wallet-check.mjs` from `app`.

The polish preview runs at `http://localhost:3004`.

### Original implementation verification

On 5 October 2026: all 36 unit tests passed; ESLint, TypeScript, production build, and the full browser journey passed. Screenshots were visually inspected on desktop and mobile. All review findings were addressed; no application defects were deferred. The preview runs locally at `http://localhost:3003`.

## Landing story and RPC pressure — 5 October 2026

The landing page follows the same 100 USDC / 1.1 wSOL / seven-day example through offer, acceptance, and 105 USDC repayment, then explains liquidation and expiry. Generated brand artwork, prompts, model, and costs are recorded in [the brand asset notes](brand/README.md). Scroll-driven progress, sticky desktop loan context, and image motion preserve readable content with JavaScript disabled and honor reduced motion.

Devnet UI consumers now share configuration, price, balance, clock, and offer reads. Polling is less frequent and identical in-flight reads are coalesced. The RPC transport respects an endpoint-wide cooldown of at least 30 seconds after a 429 (and longer Retry-After values), with SDK automatic rate-limit retries disabled. Transaction sends are never automatically replayed by this layer. UI read caching does not wrap transaction pre-sign validation. The price API returns a retryable 503 with Retry-After for upstream throttling; invalid oracle data still fails closed.

These changes reduce application-generated traffic; the shared public Devnet endpoint can still rate-limit traffic from other tabs, apps, or users on the same IP. A dedicated Devnet RPC can be configured through `NEXT_PUBLIC_SOLANA_RPC_URL` and its matching `NEXT_PUBLIC_SOLANA_WS_URL` when needed. No private RPC credential should be placed in a public browser variable.

Additional browser coverage: `PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/landing-check.mjs` from `app` (defaults to port 3004). Tests exercise chapter progress, image decoding, motion/reduced motion, mobile containment, coalesced config reads, and a simulated 429 cooldown. No transactions are signed.

Final verification for this pass: 42 unit tests, ESLint, TypeScript, production build, the full demo browser suite, the wallet fixture suite, and the landing/throttling browser suite passed. The throttling fixture observed one shared config request, one RPC request during cooldown, and one price request. Desktop and mobile screenshots were inspected. An independent review found no additional defects. Existing upstream Pyth/Anchor bundling warnings remain.
