# Lendspan

Clear terms. One loan at a time.

A local Solana program for a single loan: a lender locks USDC, a borrower locks wSOL and receives the USDC, and the program repays, expires, or liquidates without a server.

This repo includes the Anchor program ([`isolated_loan/`](isolated_loan/)), three outcome scripts, tests, and **Lendspan**, the Next.js interface ([`app/`](app/)).

## Quick start

### 1. Program

```bash
cd isolated_loan
anchor build
```

Start Surfpool (`brew install txtx/taps/surfpool`), then deploy to it. Surfpool provides the mock Pyth account and clock warp:

```bash
surfpool start --no-tui          # in one terminal
solana -u localhost airdrop 100
solana -u localhost program deploy target/deploy/isolated_loan.so \
  --program-id target/deploy/isolated_loan-keypair.json
```

### 2. Three outcome scripts

Each script runs from a **fresh** local setup (mints, three wallets, mock Pyth account):

```bash
cd isolated_loan
npm install
npm run script:repay       # → status Repaid
npm run script:liquidate   # → status Liquidated
npm run script:expire      # → status Expired
```

Requires RPC at `http://127.0.0.1:8899` with `surfnet_setAccount` and `surfnet_timeTravel` (Surfpool 1.x). Plain `solana-test-validator` needs real Pyth updates instead.

### 3. Lendspan

```bash
cd app
npm install
cp .env.example .env.local
npm run dev
```

Open the URL printed by Next.js. `/` explains the journey; `/demo` is a wallet-free simulation with editable terms, role balances, receipts, and replayable repayment, liquidation, and expiry. No validator or account is needed for the simulation.

`/devnet` connects a browser wallet to the deployed loan program using canonical test USDC, native wSOL, real Pyth updates, and real chain time. It guides funding and explicit SOL wrapping. See [Devnet configuration and evidence](docs/devnet.md). Devnet transactions use test tokens but still require wallet signatures and SOL for fees.

### 4. Tests

```bash
cd isolated_loan
npm run test:rust     # integer math worked example
npm run test:litesvm  # every instruction on LiteSVM (story 5.1)
npm run test:ts       # display math + PDA seeds

cd ../app
npm test              # wizard validation, collateral math, u64 seeds
```

## Program surface

| Item | Value |
| --- | --- |
| Program id (local and Devnet) | `CKvMgaAJmtoUN73wDxAKvjYs2d5fcirttjjEjrV9hnef` |
| Offer PDA | `["offer", lender, offer_id_le]` |
| USDC vault | `["usdc-vault", offer]` (closed after accept) |
| wSOL vault | `["wsol-vault", offer]` |

**Instructions:** `create_offer`, `cancel_offer`, `accept_offer`, `repay_loan`, `claim_expired_loan`, `liquidate_loan`, `close_offer`. Vault rent always returns to the party that paid it.

**Statuses:** Open, Filled, Repaid, Expired, Liquidated, Cancelled.

## Assumptions (week 1)

- USDC is one dollar (no USDC price feed).
- Missing the deadline gives the lender all wSOL.
- Local scripts use mock mints; Devnet uses canonical test USDC and native wSOL.

Formulas, caps, Pyth feed id, and the worked example are in [docs/research.md](docs/research.md). Accounts and instruction rules are in [docs/architecture.md](docs/architecture.md). UI copy and layout are in [docs/design-and-experience.md](docs/design-and-experience.md).

## Docs

- [Research](docs/research.md)
- [Product requirements](docs/prd.md)
- [Architecture](docs/architecture.md)
- [Design and experience](docs/design-and-experience.md)
- [Stories](docs/stories.md)
- [Sprint plan](docs/sprint-plan.md)

If you are implementing against the spec, start at [AGENTS.md](AGENTS.md).
