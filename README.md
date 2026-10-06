<p align="center">
  <img src="app/app/icon.png" alt="ZenLo logo, a pebble crossed by a wave" width="64" height="64">
</p>

<h1 align="center">ZenLo</h1>

<p align="center"><strong>Clear terms. Zero drama.</strong></p>

<p align="center"><a href="https://zenlo-loans.vercel.app">zenlo-loans.vercel.app</a></p>

ZenLo makes fixed-term lending on Solana easier to understand. A lender offers USDC, a borrower locks wrapped SOL as collateral, and an on-chain program enforces the agreed repayment amount, deadline, and settlement rules.

Start with a guided, wallet-free demo. Then explore the same loan lifecycle on Devnet with a connected wallet and test tokens.

**[Run the demo](#quick-start)** · [How it works](#how-it-works) · [Devnet guide](docs/devnet.md) · [Architecture](docs/architecture.md) · [Verification](docs/lendspan-verification.md)

**Project status:** working browser simulation and deployed Solana Devnet program. Devnet uses test tokens; this repository is not a mainnet lending service.

## How it works

**Set the terms → Lock collateral → Receive USDC → Repay and release collateral**

For example, a lender can offer **100 USDC** for **seven days**, with **5% full-term interest** and **1.1 wSOL** in collateral. Once a borrower accepts, the clock starts. Repaying **105 USDC** before the deadline returns the collateral to the borrower. Early repayment carries the same full-term interest.

Each offer has its own accounts and vaults. The lender can cancel before acceptance. After acceptance, the loan ends through one of three outcomes:

| Outcome | What happens |
| --- | --- |
| Repayment | The borrower pays principal plus fixed interest; the lender receives USDC and the borrower recovers the wSOL. |
| Liquidation | If the loan reaches its liquidation threshold before expiry, a liquidator pays the debt and receives collateral plus a capped incentive. Remaining collateral returns to the borrower. |
| Expiry | After the deadline, repayment stops and the lender can receive all collateral. Its value may be less than the debt. |

The protocol assumes USDC is worth one dollar and uses Pyth SOL/USD prices for collateral checks. Interest is a cost for the full term, not an annual percentage rate. See [formulas, limits, and rounding](docs/research.md) for the exact rules.

## Quick start

The browser demo needs Node.js, npm, and no wallet or local validator. Node.js 24 or later satisfies the current dependency requirements.

```bash
git clone https://github.com/tantshirt/isolated-fixed-term-lending.git
cd isolated-fixed-term-lending/app
npm ci
cp .env.example .env.local
npm run dev
```

Open the URL printed by Next.js.

| Route | Experience |
| --- | --- |
| `/` | An illustrated loan story with scroll progress and reduced-motion support. |
| `/demo` | A browser-only simulation with practice balances, editable terms, role switching, and replayable outcomes. |
| `/devnet` | Wallet-connected offers, funding guidance, and transactions on Solana Devnet. |

### Try your first simulated loan

1. **Set the terms.** Follow the four-step wizard and review the repayment amount and collateral.
2. **Become the borrower.** Switch roles, lock simulated wSOL, and receive simulated USDC.
3. **Explore an outcome.** Repay, change the simulated SOL price to explore liquidation, or advance time to expiry.
4. **Inspect the result.** Review balances and receipts, then reset to try another scenario.

The simulation runs in your browser. It does not request wallet signatures, call chain APIs, or move real funds.

### Continue on Devnet

Open `/devnet`, connect a compatible Solana wallet, and follow the funding instructions for test SOL and test USDC. SOL wrapping and loan transactions require explicit wallet approval.

The picker includes Phantom, Backpack, Jupiter, and MetaMask branding. Connection availability depends on the detected wallet's Solana network and signing capabilities. MetaMask's Devnet integration uses its desktop browser extension.

The app shares duplicate reads and backs off when its RPC endpoint is rate limited. Public Devnet RPC availability can still vary. The [Devnet guide](docs/devnet.md) covers configuration, Pyth updates, deployment receipts, and recovery.

## Under the hood

| Component | Responsibility |
| --- | --- |
| [`app/`](app/) | Next.js, React, and TypeScript interface; simulation, wallet integration, and transaction recovery. |
| [`isolated_loan/programs/isolated_loan/`](isolated_loan/programs/isolated_loan/) | Rust/Anchor program; offer accounts, isolated vaults, validation, and settlement. |
| [`isolated_loan/scripts/`](isolated_loan/scripts/) | Repeatable repayment, liquidation, and expiry walkthroughs. |
| [`docs/`](docs/) | Protocol rules, architecture, design decisions, and verification evidence. |

**Program ID:** [`CKvMgaAJmtoUN73wDxAKvjYs2d5fcirttjjEjrV9hnef`](https://explorer.solana.com/address/CKvMgaAJmtoUN73wDxAKvjYs2d5fcirttjjEjrV9hnef?cluster=devnet)

The program exposes `create_offer`, `cancel_offer`, `accept_offer`, `repay_loan`, `claim_expired_loan`, `liquidate_loan`, and `close_offer`. Vault rent returns to the party that paid it; the lender can close a settled offer to recover its account rent.

The client checks the configured network, simulates transactions before signing, retains transaction receipts, and reconciles uncertain submissions before retrying. Pyth owner, feed, verification level, confidence, and freshness checks remain enforced.

## Local program development

Program work also requires Rust, the Solana CLI, Anchor, and Surfpool. The local walkthroughs use mock mints and Pyth data; Devnet uses canonical test USDC and native wSOL.

```bash
cd isolated_loan
npm ci
anchor build
```

Start Surfpool in a separate terminal:

```bash
surfpool start --no-tui
```

Then fund the local deployer and deploy from `isolated_loan/`:

```bash
solana -u localhost airdrop 100
solana -u localhost program deploy target/deploy/isolated_loan.so \
  --program-id target/deploy/isolated_loan-keypair.json
```

Run the outcome scripts against the local RPC:

```bash
npm run script:repay
npm run script:liquidate
npm run script:expire
```

Each script creates a fresh local setup. The scripts require Surfpool's `surfnet_setAccount` and `surfnet_timeTravel` methods; a plain Solana test validator does not provide these mock-account and clock controls.

## Validation

From `app/`:

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

From `isolated_loan/`:

```bash
npm run test:rust
npm run test:litesvm
npm run test:ts
```

The latest interface verification includes **42 passing unit tests**, a production build, and browser checks covering the demo lifecycle, wallet fixtures, responsive layouts, reduced motion, and RPC backoff. Live Devnet evidence covers create, accept, repay, cancel, expiry, and close. Real browser-extension signing is not automated; forced Devnet liquidation is not part of that evidence.

See [verification commands and limitations](docs/lendspan-verification.md) for reproducible browser checks and [Devnet evidence](docs/devnet.md) for transaction details.

## Find your next step

| I want to… | Start here |
| --- | --- |
| Understand the product and scope | [Product requirements](docs/prd.md) |
| Check a formula or protocol limit | [Research and worked examples](docs/research.md) |
| Integrate with the program | [Accounts and instruction rules](docs/architecture.md) |
| Work on the interface | [Design and experience](docs/design-and-experience.md) |
| Review generated brand assets | [Artwork, prompts, and provenance](docs/brand/README.md) |
| Contribute an implementation | [Agent guide](AGENTS.md) · [Sprint plan](docs/sprint-plan.md) · [Stories](docs/stories.md) |

For a reproducible issue, include the route, network, expected behavior, and failing step. Include a public transaction signature when relevant; leave out credentials, seed phrases, and wallet secret keys.
