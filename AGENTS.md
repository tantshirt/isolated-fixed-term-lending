# Agent guide

This repo is Lendspan, an isolated fixed-term USDC / wSOL loan on Solana. The local program and first interface are implemented. The approved redesign adds a wallet-free simulation and a genuine Devnet experience.

You do not need any extra planning tools. The work queue is in this repo.

## How to start

1. Ask which lane the person is on, if they have not said. The lanes are not tied to a name.
   - Program lane: the Anchor program, accounts, vaults, and loan instructions.
   - Oracle and client lane: Pyth checks, tests, client scripts, and docs.
2. Open [docs/sprint-plan.md](docs/sprint-plan.md). Take the next story in that lane whose status is Open.
3. Open that story in [docs/stories.md](docs/stories.md). Implement only its acceptance checks.
4. Before you invent a number, a seed, or a status, read the section the story points at.
   - Formulas, caps, feed id, and rounding: [docs/research.md](docs/research.md)
   - Accounts, seeds, instructions, and what fails closed: [docs/architecture.md](docs/architecture.md)
   - What the product is and what is out of week 1: [docs/prd.md](docs/prd.md)
5. When the story is done, set its status to Done in the sprint plan.

## How it should look

Week 1 does not start the frontend. If the story is Epic 7, or the person explicitly asks for the interface, follow [docs/design-and-experience.md](docs/design-and-experience.md).

That file describes Lendspan: Astryx semantic tokens, light white/cool-neutral surfaces and blue primary actions. Inter carries words and aligned tabular figures; monospace is for addresses and technical details. Create is a four-step wizard with a live summary. The landing page tells the loan story with native scroll animations. Simulation and Devnet remain explicitly separate, with no sign-in. Do not switch the app to a dark canvas or hardcode hex outside the token block in `app/app/globals.css`. The project design council is documented in `.design-council/README.md`.

## Leave these alone

Do not start the frontend build, an indexer, Trident fuzzing, or a devnet deploy while any Epic 1–6 story is still Open. Do not add partial liquidation, auto-refinance, per-second interest, or a USDC price feed. Do not weaken the Pyth owner check so a test can pass.

If a formula in the research note disagrees with a test you trust, change the note and the test in the same change. Do not silently pick a third rule.
