# Isolated loan UI (Week 2)

Next.js 15 client for the local `isolated_loan` Anchor program.

## Prerequisites

- Node 20+
- `solana-test-validator` on `http://127.0.0.1:8899`
- Program deployed at `CKvMgaAJmtoUN73wDxAKvjYs2d5fcirttjjEjrV9hnef` (`anchor deploy` from `isolated_loan/`)
- For mock Pyth prices: Surfpool/surfnet with `surfnet_setAccount`, or post real updates via the Pyth receiver

Sync the IDL after program changes:

```bash
cp ../isolated_loan/target/idl/isolated_loan.json idl/isolated_loan.json
```

## Scripts

```bash
npm install    # first time in app/
npm run dev    # Next dev (Turbopack)
npm run build
npm start
```

### Blank page in dev

If the browser shows a white screen after many edits, Turbopack HMR may be stuck. Stop every `next dev` process, then:

```bash
rm -rf .next && npm run dev
```

Use the URL printed in the terminal (often `http://localhost:3000`; if the port is taken, Next picks another).

## Design tokens

The UI uses **Astryx Neutral** in light mode only. `app/layout.tsx` sets `data-astryx-theme="neutral"` and `data-theme="light"` on `<html>`. Component styles reference semantic tokens from `@astryxdesign/theme-neutral` (no parallel hex palette in the app).

## Local flow

1. Start validator and deploy the program.
2. `npm run dev` and open the app.
3. Use the **Local setup** strip under the header → **Fund roles** (calls `POST /api/setup`: mints, ATAs, role keypairs in `localStorage`, mock price account).
4. **Acting as** in the same strip switches Lender / Borrower / Liquidator signing keypairs.
5. Create → **Lock USDC**; offers appear on `/` via `.local/offers-index.json`.
6. Borrower → **Review** → **Lock wSOL and borrow** (needs fresh price from `POST /api/set-price` on surfnet).
7. Repay, claim expired, or liquidate per role.

API routes: `setup`, `set-price`, `list-offers`, `register-offer`, `price`.
