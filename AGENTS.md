# Agent guide

This repo is ZenLo, an isolated fixed-term USDC / wSOL loan on Solana. The public and private programs, the interface and the Devnet experience are implemented (Epics 1–18). The approved desk-first roadmap (Epics 19–27) adds private lender desks, borrower protections in separate V2 programs, a Convex backend and Squads governance.

You do not need any extra planning tools. The work queue is in this repo.

## How to start

1. Ask which lane the person is on, if they have not said. The lanes are not tied to a name.
   - Program lane: the Anchor program, accounts, vaults, and loan instructions.
   - Oracle and client lane: Pyth checks, tests, client scripts, and docs.
   - Desk lane: the desk-first roadmap. Take the next Open row whose dependencies are Done.
2. Open [docs/sprint-plan.md](docs/sprint-plan.md). Take the next story in that lane whose status is Open.
3. Open that story in [docs/stories.md](docs/stories.md). Implement only its acceptance checks.
4. Before you invent a number, a seed, or a status, read the section the story points at.
   - Formulas, caps, feed id, and rounding: [docs/research.md](docs/research.md)
   - Accounts, seeds, instructions, and what fails closed: [docs/architecture.md](docs/architecture.md)
   - What the product is and what is out of week 1: [docs/prd.md](docs/prd.md)
5. When the story is done, set its status to Done in the sprint plan.

## How it should look

Week 1 does not start the frontend. If the story is Epic 7, or the person explicitly asks for the interface, follow [docs/design-and-experience.md](docs/design-and-experience.md).

That file describes ZenLo: the pebble-and-wave mark (no mascot), abstract pebble-and-water art that never sits next to figures, risk or signing controls, Astryx semantic tokens, white and cool-blue surfaces, navy ink and blue primary actions, with navy panels for private features. Nunito carries words and aligned tabular figures; monospace is for addresses and technical details. The approved screens are the design canvas linked from that file. Create is a four-step wizard with a live summary. The landing page tells the loan story with native scroll animations. Simulation and Devnet remain explicitly separate. There is no account sign-up: a remembered wallet is the returning user's identity. Do not switch the app to a dark canvas or hardcode hex outside the token block in `app/app/globals.css`. The project design council is documented in `.design-council/README.md`.

## Leave these alone

Do not weaken the Pyth owner check so a test can pass. Do not add partial liquidation, auto-refinance, or a USDC price feed.

The legacy programs (`isolated_loan` `CKvMga…`, `private_loan` `HwK4hx…`) keep their week-1 economics: flat full-term interest, no partial repayment, no top-up, no grace. Never change their account layouts or apply V2 rules to their loans. Pro-rata accrual, partial repayment, top-up, grace, late fees and borrower-consented refinancing belong only in the V2 programs, following [docs/research.md](docs/research.md).

Never move private conversations, private books, raw income proofs or viewing keys into Convex, telemetry, exports or notifications. Do not shorten the seven-day recovery window to produce evidence. Do not install Light, Inco or a confidential-token stack; they are research references. Arcium is used only by `zenlo_credit_mxe`; its inputs must be rollup-signed history attestations, never self-reported.

Open pull requests but do not merge them. The repo owner merges.

If a formula in the research note disagrees with a test you trust, change the note and the test in the same change. Do not silently pick a third rule.
