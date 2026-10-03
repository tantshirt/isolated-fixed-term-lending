# Isolated fixed-term lending

A local Solana program for a single loan. A lender locks USDC. A borrower locks wSOL and receives the USDC. The program repays the loan, gives the collateral to the lender after the deadline, or liquidates the loan if the SOL price falls through the line. No server is required.

Week 1 is the program, tests for those three endings, client scripts, and these docs. The interface, an indexer, fuzzing, and devnet come after that.

## Docs

- [Research](docs/research.md) — how similar protocols work, and the integer formulas this one uses
- [Product requirements](docs/prd.md)
- [Architecture](docs/architecture.md)
- [Design and experience](docs/design-and-experience.md)
- [Stories](docs/stories.md)
- [Sprint plan](docs/sprint-plan.md)
- [Implementation readiness](docs/implementation-readiness.md)

If you are writing code, start at [AGENTS.md](AGENTS.md).

## Lanes

Two lanes, not assigned to a name.

- Program: accounts, vaults, and the loan instructions.
- Oracle and client: the Pyth checks, tests, client scripts, and the docs that sit next to the code.

## Week-1 assumptions

USDC counts as one dollar. Missing the deadline gives the lender the wSOL. The test mints are not mainnet USDC or wrapped SOL. The exact caps and the worked example are in the research note.
