# Stories

Two lanes. Neither lane is assigned to a person. Say which lane you are on, then take the next open story in that lane from [sprint-plan.md](sprint-plan.md).

The program lane builds the Anchor program, accounts, vaults, and loan instructions. The oracle and client lane builds the price checks, the tests, the client scripts, and the docs that sit next to the code.

Week-2 stories are listed so they are not forgotten. They stay out of the seven days.

## Epic 1. Program skeleton

Day 2. Program lane, with the oracle and client lane on the test fixtures.

### Story 1.1. Anchor project and offer account

The repo builds an Anchor program whose offer account matches [architecture.md](architecture.md): fields, status enum, and the three PDA seed sets.

Acceptance:

- `anchor build` succeeds.
- The offer PDA is derived from `["offer", lender, offer_id]`.
- Both vault seed sets are derived as specified, and a unit test checks the addresses.
- Status values exist for Open, Filled, Repaid, Expired, Liquidated, and Cancelled.

### Story 1.2. Local mints and wallets

Three wallets exist in the test setup: lender, borrower, liquidator. Two classic SPL mints exist: 6 decimals and 9 decimals. Each wallet can hold both.

Acceptance:

- A test creates the mints and the token accounts and asserts the decimals.
- The same setup is what later instruction tests call. They do not each invent a mint.

## Epic 2. Create, cancel, and accept

Day 3.

### Story 2.1. Create and cancel

Program lane.

Acceptance:

- The lender can create an offer and the USDC vault balance equals `principal`.
- A rate, term, or LTV outside the caps in [research.md](research.md) fails.
- The lender can cancel an open offer and receives the USDC back.
- A stranger cannot cancel.
- Cancelling a filled offer fails with the wrong-status error.

### Story 2.2. Accept

Oracle and client lane for the price account. Program lane for the token moves. Pair on this story.

Acceptance:

- Accept moves principal USDC to the borrower and `collateral_amount` wSOL into the wSOL vault.
- `start_ts` and `expiry_ts` come from the Clock sysvar.
- The USDC vault is closed after accept.
- Accept fails when the worked example's collateral would break the 70% cap, using the integers in the research note.
- The borrower and the lender cannot be the same pubkey.

## Epic 3. Repay and expiry

Day 4.

### Story 3.1. Repay

Program lane.

Acceptance:

- Before `expiry_ts`, the borrower pays `debt` USDC to the lender and receives every lamport of wSOL back.
- `debt` matches `ceil(principal * interest_bps / 10_000) + principal` from the research note.
- Repay at `expiry_ts` fails.
- A second repay fails.
- A stranger cannot repay.

### Story 3.2. Claim expired

Oracle and client lane.

Acceptance:

- Claim at `expiry_ts - 1` fails.
- Claim at `expiry_ts` sends all wSOL to the lender and none to the borrower.
- No USDC moves on claim.
- Claim before the loan is filled fails.
- A second claim fails.

## Epic 4. Oracle and liquidation

Day 5.

### Story 4.1. Price checks

Oracle and client lane.

Acceptance:

- Accept and liquidate call `get_price_no_older_than` with a 60 second maximum age and Full verification.
- The account owner must be `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`.
- The feed id must be `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`.
- Confidence wider than 2% of price, a non-positive price, and an exponent outside -12..-3 each fail.
- Tests do not disable the owner check. They build a `PriceUpdateV2` with that owner.

### Story 4.2. Integer value and LTV

Program lane, shared with 4.1.

Acceptance:

- Pure tests assert the worked example: 1 wSOL at price 150.00 and conf 0.15 values at 149.85 USDC, the 100 USDC loan at 5% needs at least 1.001001002 wSOL at 70% LTV, and 80% liquidation trips at 131.25 USDC of collateral.
- Collateral value rounds down. LTV and interest round up. The implementation uses `u128` and rejects overflow.

### Story 4.3. Liquidate

Oracle and client lane for the cases. Program lane for the split.

Acceptance:

- A healthy loan fails with the healthy-loan error.
- An unhealthy loan moves `debt` USDC from the caller to the lender, sends the caller wSOL worth debt plus 5%, and returns the remainder to the borrower.
- The borrower cannot liquidate.
- Liquidate at or after `expiry_ts` fails. Claim is the only ending then.
- A stale price and a mismatched feed id fail, and no tokens move.

## Epic 5. The three outcomes, end to end

Day 6. Oracle and client lane, with the program lane fixing whatever the tests find.

### Story 5.1. Permission and double-settlement sweep

Acceptance:

- A test matrix covers stranger cancel, stranger repay, borrower liquidate, and a second call of each settlement.
- After each ending the wSOL vault is closed and its balance is not still sitting on the offer.

### Story 5.2. Three client scripts

Acceptance:

- One script runs accept then repay and prints status `Repaid` and the expected balances.
- One script runs accept then liquidate against a crossed price and prints status `Liquidated`.
- One script runs accept, warps the clock to `expiry_ts`, claims, and prints status `Expired`.
- Each script starts from the shared local setup, not from a half-finished previous run.

## Epic 6. Make it presentable

Day 7. Both lanes.

### Story 6.1. Clean errors and a fresh run

Program lane on the errors. Oracle and client lane on the writeup.

Acceptance:

- Every failure in the stories above maps to a named error, not a generic overflow or a raw program error.
- A new clone can follow the README, run the three scripts, and see the three statuses.
- The README lists the accounts, the seeds, the six instructions, and the assumptions in the research note (USDC is one dollar, expiry gives the lender the wSOL, local mints are not mainnet).

## Epic 7. Week 2

Not in the seven-day queue. Do not start these while an Epic 1–6 story is open.

### Story 7.1. Interface

Build the screens in [design-and-experience.md](design-and-experience.md). Light Astryx Neutral tokens. The three journeys, including empty, loading, success, and error. The program remains the source of LTV.

### Story 7.2. Devnet, indexer, fuzz

Deploy to devnet with the real USDC and wSOL mints and a real Pyth update. An indexer and Trident fuzzing come after the deploy is reproducible, not before.

## Epic 8. Private protocol: compatibility and privacy proof

Private lane. This is a gate, not a feature. Each story records PASS or FAIL with raw evidence (signatures, RPC dumps) in [magicblock-evidence.md](magicblock-evidence.md). A failed gate keeps its feature unavailable. It never switches the feature to public execution and never weakens the Pyth checks.

### Story 8.1. Pin the toolchain

A new `private_loan` program builds in the `isolated_loan/` workspace beside the public program, with its own program id.

Acceptance:

- `anchor build` builds both programs with `ephemeral-rollups-sdk` 0.17.3 (feature `anchor`) on the existing anchor-lang 1.x and Rust 1.89.
- The SDK, delegation, permission, eSPL, Hydra, and TEE validator ids are pinned in one constants file and in the evidence file.
- `session-keys` builds under anchor 1.x, or the evidence records why not and Lendspan uses its own scoped session account instead.

### Story 8.2. TEE auth and permissions

Acceptance:

- A script verifies the Devnet TEE attestation and obtains an auth token before sending any private request.
- A permissioned, delegated account is readable by a member.
- An outsider gets no contents through `getAccountInfo`, `getProgramAccounts`, `accountSubscribe`, or transaction logs.

### Story 8.3. ER-only accounts

Acceptance:

- A record created with `#[ephemeral_accounts]` never appears on the base layer, before or after commit and undelegate of its neighbours.
- The behaviour of that record across a validator restart is recorded, whatever it is.

### Story 8.4. Program-controlled eSPL custody

Acceptance:

- A program PDA owns an eATA for Devnet USDC and one for wSOL.
- Deposit, delegate, a PDA-signed transfer inside the ER, and withdraw all succeed with exact balances.

### Story 8.5. Canonical Pyth inside the PER

Acceptance:

- The shared Pyth check reads the cloned Pyth Receiver `PriceUpdateV2` (owner `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`) inside the TEE.
- A stale clone fails with `StalePrice`.
- The MagicBlock pricing oracle is not accepted in its place.

### Story 8.6. Private scheduled execution

Acceptance:

- A Hydra crank calls a permissionless instruction on a private account.
- The scheduler operator holds no read permission on that account.
- A retry after the account has settled does nothing.

### Story 8.7. Commit visibility

Acceptance:

- The base-layer commit of a permissioned account is inspected, and what it exposes is written down.
- Any plaintext leak of terms or identities blocks the dependent feature.

## Epic 9. Private foundation

Private lane. Only features whose Epic 8 gate passed.

### Story 9.1. Shared loan core

The loan math and the Pyth check move into `isolated_loan/crates/loan-core`. Both programs use it.

Acceptance:

- `npm run test:rust` and `npm run test:litesvm` pass with no change to the public program's behaviour.
- The worked-example vectors live in one file that the Rust and TypeScript tests both read.

### Story 9.2. Rooms, invitations, and scoped sessions

Acceptance:

- Opening a room creates the room, its permission, and its delegation in one transaction.
- Seeds use opaque random ids, never wallets or terms.
- Only the primary wallet can invite or revoke. A link alone grants nothing.
- A session key can post a message but cannot fund, accept, repay, withdraw, grant access, or approve a disclosure.
- An expired or revoked session fails.

### Story 9.3. Private balances

Acceptance:

- A user can deposit USDC, wrap and deposit wSOL, and withdraw to a reviewed destination.
- Every externally built transaction is checked for programs, accounts, mint, amount, destination, fee payer, and network before the wallet signs.
- Fees show separately from principal and interest.

### Story 9.4. Execution receipts and recovery

Acceptance:

- A receipt records environment, intent, revision, ER signature, commit id, and base signature.
- It shows "executed" separately from "settled".
- An uncertain submission survives a reload and is reconciled without a second token movement.
- A private request is never sent to a public endpoint.

## Epic 10. Complete private loan

### Story 10.1. Fund, accept, repay, cancel, expire, withdraw

Acceptance:

- Each loan has its own PDA-owned eATAs. No instruction can move another loan's balance.
- Both approvals bind to the same terms revision. Any financial edit invalidates them.
- The shared `loan-core` vectors (worked example, rounding) back both programs. Deadline boundaries, permissions, revisions, and double-settlement rejection are checked on Devnet, because the ER instructions cannot run in LiteSVM.
- A full lifecycle runs on the Devnet TEE, and its signatures are recorded.

## Epic 11. Discovery and AI

### Story 11.1. Discovery cards and competing proposals

Acceptance:

- A public card holds only the fields the publisher selected.
- A competing lender sees their own proposal and the disclosed request, never another lender's.
- Accepting one funded offer invalidates the selection of the others. Unused funded offers stay cancellable.

### Story 11.2. AI request and callback

Acceptance:

- The user sees the exact excerpt, provider, and model before anything is sent.
- The request binds the payload hash, approval, and terms revision.
- A forged, duplicate, late, or stale callback cannot modify the current draft.
- Model output never changes loan status, prices, eligibility, or settlement.

## Epic 12. Automated settlement

### Story 12.1. Expiry tasks and liquidation tickets

Acceptance:

- Expiry runs from a permissionless crank with fixed destinations, and it is harmless after settlement.
- A liquidator funds a ticket from a short-lived quote without reading the loan.
- Execution rechecks price, status, deadline, and limits. It settles once, or the ticket becomes refundable.
- The Devnet liquidator's capital is separate from user deposits.

### Story 12.2. Magic Actions receipts

Acceptance:

- A minimal receipt is posted on settlement.
- A direct, forged, or duplicate action call fails.

## Epic 13. Optional integrations and polish

### Story 13.1. Transfers, sponsorship, lab, and accessibility

Acceptance:

- Private transfers and gas sponsorship are bounded and never change approved financial contents.
- `/devnet/private/lab` VRF scenarios and SOAR achievements are opt-in and confer no loan advantage.
- Keyboard, mobile, wallet switching, and rejected signatures all work on `/devnet/private`.

## Epic 14. Discover marketplace

### Story 14.1. Borrower requests

Acceptance:

- A borrower can post a request that locks collateral, cancel it while open, and close it once funded or cancelled.
- A lender funds a request in one instruction. Funding checks Pyth and the max LTV, pays the borrower, and creates an ordinary filled offer.
- Repay, claim, liquidate, and close work on that offer unchanged. The `Offer` layout does not change.
- Rent returns to whoever paid it, in amount.

### Story 14.2. Client and live reads

Acceptance:

- The client lists open requests, offers, and discovery cards from Devnet.
- Lists update within seconds through account subscriptions and fall back to polling when the socket drops. The interface says which.

### Story 14.3. Discover page

Acceptance:

- `/devnet/discover` is in the main navigation. Borrowers asking and Lenders offering each show Public and Private.
- Private borrower cards keep the selected-fields rule from 11.1. Lenders offering in private is explained, not invented.
- A lender can fund a public request from the page, and is told first when a price update needs extra signatures.

### Story 14.4. Request a loan

Acceptance:

- A borrower chooses Public or Private. Public posts a request through a four-step wizard with a live summary. Private goes through a room and a discovery card.
- Wrapping SOL is an explicit step, never silent.

## Epic 15. ZenLo rebrand

LegitShark and Sharky are retired. The product is **ZenLo**: a pebble-and-wave mark, Nunito, blue and navy on white, abstract pebble-and-water art. The rename is display-only; programs, IDLs, seeds and storage keys keep their names. The approved design canvas is linked from [design-and-experience.md](design-and-experience.md).

### Story 15.1. Brand foundation

Acceptance:

- Tokens add navy, cloud and sky; ink is navy; Nunito replaces Inter; radii are rounder. Hex stays inside the token block.
- The header and footer show the ZenLo mark and name. Favicon, Apple icon and the social share image use the mark.
- Every user-facing "LegitShark" outside the landing page reads ZenLo, including errors, wallet metadata and the copilot prompt.

### Story 15.2. Abstract art set

Acceptance:

- Use cases, loan-story chapters, the private chapter and empty or error states each have their own generated image in one consistent pebble-and-water style.
- Prompts and receipts are recorded in `docs/brand/`. No art sits beside figures, risk copy or signing controls.

### Story 15.3. Landing and use cases

Acceptance:

- The landing page follows the approved canvas: hero, promises, contrast, the loan story with its tracker, three endings, private chapter, a three-card use-case snippet linking to `/use-cases`, FAQ and a final call to action.
- `/use-cases` shows all six cases with new art and Public or Private filters.

### Story 15.4. App restyle without Sharky

Acceptance:

- No Sharky image, component or copy remains in the app. Empty and error states use the new spot art.
- Devnet screens follow the canvas: header, Discover, create wizard, offer and request detail, private home and rooms.

## Epic 16. My loans

### Story 16.1. Per-wallet reads

Acceptance:

- Offers and requests can be read by lender or borrower with account filters, without loading every account.
- A portfolio model orders items by urgency: past due, due within a day, near the liquidation line, then open. Unit tests cover the order.

### Story 16.2. My loans page

Acceptance:

- `/devnet/me` shows totals and two tabs. Lenders see open offers, running loans with countdown and health, loans ready to claim, liquidatable loans and funded requests. Borrowers see running loans with repay, and open requests.
- Each deadline can be added to a calendar. Recent activity links to the explorer.

### Story 16.3. Returning wallets

Acceptance:

- A remembered wallet reconnects on reload and the header shows My loans with a count of items that need attention.
- Changing wallets refreshes every view and says which wallet is now active. Loans due within a day or near their line raise an in-app banner.

## Epic 17. Rooms and invites

### Story 17.1. Finding your rooms

Acceptance:

- An invited wallet sees the room in an invites list without being sent a link. The rollup lists only rooms the caller may read, so no inbox account is needed (evidence 2026-10-06).
- A non-member who opens a room link can ask to join from that screen.

### Story 17.2. Owners and requests to join

Acceptance:

- The owner chooses a role when admitting a request and can dismiss requests. The queue reads oldest first.
- A half-created room can be finished. A card is updated or retracted rather than duplicated, and links to its room.

### Story 17.3. Loans and bids that stay visible

Acceptance:

- Every loan proposed in a room stays listed regardless of thread length, including when the follow-up message failed.
- Lenders see all their private bids with status: proposed, funded, accepted or settled. A funded bid always says how to cancel it, because only the borrower can see which offer was accepted.
- The private sign-in survives a reload in the same tab until it expires; session keys stay in memory only.

## Epic 18. Full cycle

### Story 18.1. Both sides, end to end

Acceptance:

- A scripted Devnet run covers public offer → accept → repay, request → fund → expire → claim, and private room → invite → inbox → card → two bids → accept → repay, with both wallets' My loans pages updated.
- The full design council reviews every screen and records its ruling.

## Desk-first roadmap (approved 2026-10-07)

Epics 19–28 come from the consolidated roadmap: find a counterparty, agree terms, fund, manage, settle, reuse the relationship. Private lender desks are the first commercial hypothesis. Stages 0–4 build up to a customer gate; Stage 5 is that gate; Stages 6–7 stay queued until it passes.

Rules that apply to every story below:

- New economics ship in separate V2 programs (`isolated_loan_v2`, `private_loan_v2`) with their own program IDs and versioned accounts. Legacy loans keep their original programs, layouts, codecs and servicing. V2 economics never apply retroactively.
- Convex holds consented profiles, preferences, operational metadata, notifications, provider sessions, activity projections and durable jobs. Private conversations, full private books, raw income proofs and viewing keys never go to Convex, telemetry, exports or notifications.
- Desk pricing caps are product controls. Devnet policy fixtures are labelled test settings and make no jurisdiction-compliance claim. Legal work is out of scope for this Devnet build.
- A provider capability is specific to network and mint. An unsupported operation stays unavailable with a stated reason, and any simulation of it is labelled.
- Long-duration Devnet settlement fixtures start early. Production rules are never shortened to produce seven-day recovery evidence.
- Each story ships its program and client changes, interface, simulation behavior, tests and docs together. It is Done only when acceptance evidence exists.

## Epic 19. Foundation (Stage 0–1)

### Story 19.1. Lender pilot kit

Acceptance:

- `docs/pilot/` has an interview script, an onboarding guide, an observation checklist and a comprehension check covering funding authority, auditor access and terminal collateral loss.
- A list of developer wallets excluded from every pilot metric is checked in, and the metrics code reads it.
- Onboarding reuses the existing room invites and join requests (Epic 17). No new invite system.

### Story 19.2. Convex and wallet sign-in

Acceptance:

- Convex is provisioned through the Vercel Marketplace, with separate dev, preview and production deployments.
- A wallet challenge is domain-bound, expires within 5 minutes and can be used once. Tests reject a replayed nonce, the wrong domain, an expired challenge and the wrong signer.
- Verification issues a short-lived JWT that Convex accepts through custom JWT auth. Authorization comes from the verified identity, never from a wallet address the client supplies.
- Changing the connected wallet clears wallet-specific state and the backend session.

### Story 19.3. Durable jobs, capabilities and operations

Acceptance:

- Jobs have a deduplication key, bounded retries with backoff, a last error, and reconciliation of any uncertain transaction signature before a resubmit.
- A capability table keyed by network, mint and provider drives every provider action in the interface.
- Flags can pause new originations or a single provider without blocking repayment, liquidation or claims on existing loans.
- Monitors report job and watch lag, oracle freshness, stuck provider sessions, uncertain signatures and authorization failures.
- The cranker runs in shadow inside Convex and its decisions are diffed against Vercel Cron. Only one scheduler is active at a time, and cutover happens after 7 days of zero diffs.

### Story 19.4. Versioned models and the shared loan view

Acceptance:

- Typed, versioned models exist for loan terms and accounting, collateral assets (mint, decimals, feed, risk limits), desks, auditor grants, automation mandates and provider capabilities.
- A single client `LoanView` gives payoff, remaining principal, risk, deadlines and the actions available now, for legacy and V2 loans alike. Every screen reads it rather than recomputing.

### Story 19.5. Governance

Acceptance:

- A 2-of-3 Squads multisig with independent signers and a default 24-hour time lock holds the V2 upgrade authorities through its vault PDA.
- A V2 `Config` account separates the AI admin, AI worker, liquidation-pool admin, credential issuer and keeper. Only the vault can rotate them. `AI_ADMIN` is no longer reused for financial administration, and no single-key bypass remains.
- Devnet evidence shows one time-locked upgrade, one key rotation and one recovery.
- Operational keys cannot change financial policy, and a test proves it.

### Story 19.6. Official asset registry

Acceptance:

- `app/public/brands/registry.json` records each logo's source, retrieval date, file hash, approved variants and intended placement.
- Logos are official artwork with their original proportions and colors. A logo appears only where that provider is actually used; anything not yet sourced is shown as a text label.

### Story 19.7. Honest shipped-feature surfaces

Acceptance:

- The landing page and `/use-cases` describe what Epics 19–24 shipped: V2 early and partial repayment, top-up, grace and late recovery, lender desks, auditor consent, private portfolios, Telegram alerts, MoneyGram cash-out and Squads governance. The FAQ no longer says a loan cannot change after it starts, and legacy loans are still described as all-or-nothing.
- Every feature claim carries a badge from `app/lib/feature-status.ts`: "Live on Devnet" only with a Devnet evidence pointer that resolves, "Pilot · gated" while its provider flag is off, and "Sandbox" for MoneyGram's sandbox. MoneyGram is never shown as live.
- Pyth, Squads, Convex, Vercel, Telegram and MoneyGram use official artwork from the registry, beside the feature that uses them, through `ProviderLogo`. Logo styles never recolor artwork. Helius stays a text label because nothing uses it.
- The MoneyGram case says the step is not private before anything else about it.

## Epic 20. Shared V2 accounting (Stage 2)

### Story 20.1. Accounting engine and parity vectors

Acceptance:

- `loan-core` tracks original and outstanding principal, accrued and paid interest, last accrual time, the fractional remainder, assessed and paid late fees, the minimum-interest policy, and the maturity, grace, recovery and terminal-claim timestamps.
- Accrual happens before principal changes. Payments apply to interest, then permitted late fees, then principal. Pro-rata accrual uses outstanding principal and stops at maturity. The remainder carries forward, so many small payments do not inflate rounding.
- Minimum interest is enforced once, at final payoff, minus interest already paid. Charge ceilings apply before the final payable amount is fixed. Origination checks the maximum contractual exposure; health and settlement use current payoff. Principal at zero is never treated as repaid while charges remain.
- `vectors-v2.json` is read by both the Rust and TypeScript tests. Property tests cover cap precedence, remainder bounds, payment order and token conservation, and show that pro-rata with no partial payments equals legacy `debt()`.
- `docs/research.md` states every formula and rounding direction. The note, the vectors and the tests change together.

### Story 20.2. Pricing ceilings

Acceptance:

- Every V2 loan carries an annual pricing ceiling: from the desk policy, or one the lender declares under a protocol maximum labelled a Devnet test setting.
- The ceiling is applied cumulatively, minus charges already paid, and rounds down. It takes precedence over full-term interest, the minimum-interest floor and any included fees.
- The interface shows term cost, annualized pricing and current payoff separately, and states the calculation basis and year convention. Optional provider and network fees are shown apart from lending charges.

### Story 20.3. Spot and EMA oracle policy

Acceptance:

- The canonical Pyth owner, verification, feed, timestamp, confidence and exponent checks are preserved. The EMA uses its own confidence interval.
- Ordinary risk liquidation requires both the conservative spot and the EMA valuations to cross the threshold. Emergency liquidation accepts a valid conservative spot alone at three LTV points above the threshold. An invalid spot price never qualifies.
- The interface explains the emergency exception to wick protection, and the note says EMA does not remove the risk of callers choosing among recent valid updates.

## Epic 21. Public V2 program (Stage 2)

### Story 21.1. `isolated_loan_v2` core

Acceptance:

- New program ID and versioned `OfferV2` and `RequestV2` accounts with the V2 ledger and an immutable `origin_lender` plus a mutable `current_lender`. PDA signing uses the immutable identity; repayment and claims go to the current lender.
- Instructions: create, cancel, accept, partial or full repay, add collateral (no oracle needed to deposit), close.
- Partial payments go to the current lender. Before signing, the review shows the payment's effect and that the deadline is unchanged. Health refreshes when a valid price is available.
- The lender chooses full-term or pro-rata early repayment within limits. The borrower sees the same rule on the listing, the review and the active loan, including any cap or minimum-interest adjustment.
- The Create and Request wizards add repayment policy, pricing ceiling, grace and late fee. Simulation and Learn use the same V2 math.
- The legacy LiteSVM suite still passes against the legacy program, unchanged. Long-duration Devnet fixtures are opened on deploy day.

### Story 21.2. Grace, recovery and surplus return

Acceptance:

- Grace defaults to 24 hours and is configurable up to 48. The late fee is a one-time 1% of principal unpaid at maturity, configurable up to 5%, subject to the ceiling.
- Before grace ends, maturity alone does not allow overdue liquidation; risk liquidation remains possible. After grace, anyone may pay the payoff in USDC regardless of LTV, receive the 5% incentive, and the surplus returns to the borrower.
- From 24 hours after grace, the lender may take debt-equivalent collateral with no bonus, the surplus returns, and any shortfall is recorded. This needs a valid oracle.
- From 7 days after grace, the lender may claim all remaining collateral without an oracle. Signing reviews and the active loan disclose the possible loss of surplus.
- Repayment stays available until a settlement executes. Repayment and competing settlement calls resolve to exactly one terminal result.
- LiteSVM covers every exact boundary, stale and missing oracles, surplus and shortfall, and repayment races. Devnet evidence comes from the fixtures in 21.1.

### Story 21.3. Public reference liquidator

Acceptance:

- A keeper funded with operator-owned Devnet USDC enforces a per-action cap, a total-capital cap and a minimum payout. It takes a fresh transaction review before each action and reconciles uncertain signatures.
- It reports depleted capital and failures. It never uses user automation allowances as capital, and the interface never promises guaranteed execution.

## Epic 22. Multi-loan private rooms (Stage 3)

### Story 22.1. `private_loan_v2` rooms with many loans

Acceptance:

- L1 loan anchors are namespaced by an immutable creator and nonce. Initial private setup requires the creator's authorization, binding to the room and valid membership.
- Sequential room indexes and registry entries are allocated atomically inside the rollup. The index is metadata, not signing authority across domains.
- Each borrowing request still accepts only one proposal, while a room can hold many loans. Each loan keeps its own custody, accounting and read permissions.
- Roles are explicit. The room-owner bypass in `propose_terms` does not exist in V2. Authorities come from `Config`.
- This closes accepted risks S6 (loan-id squatting) and S7 (one loan per room), with tests.

### Story 22.2. Private V2 protections

Acceptance:

- Private loans use the V2 ledger: partial repayment, add collateral, fair early repayment, grace, late fee, priced fallback and terminal claim, with the same vectors as the public program.
- `watch_loan` follows the V2 boundaries and the spot plus EMA policy. Watches last through recovery and are rebound when ownership changes. Stale quote revisions are invalidated.
- Losing tickets are refunded in full and winning-ticket excess funding is returned, each exactly once.
- Before this story starts, Devnet evidence shows the EMA fields can be read inside the PER.

## Epic 23. Private lender desks (Stage 3)

### Story 23.1. Desk accounts, roles and policies

Acceptance:

- A desk has an identity, private membership, immutable policy versions and a loan book. A desk is not a pooled treasury; each loan records its originating and current lender wallet.
- Roles: an administrator manages profile, membership and future policies; a lender proposes and funds from their own wallet; an auditor reads consented executed terms, status and receipts; a borrower acts on their own loans. Administration grants no spending or private-read authority.
- Policies cover assets, principal, annual pricing, duration, repayment mode, LTV, grace, fees, settlement and auditor scope, and the program enforces them at propose and accept.
- Tests cover cross-desk isolation, policy binding, role separation and the absence of an administrator spending bypass.

### Story 23.2. Desk workspace

Acceptance:

- Private gains Desks alongside Workspace and Liquidations. A desk has Overview, Loans, Policy and People.
- Overview leads with urgent loans and pending signatures. Every position names its funding wallet. Aggregate exposure is labelled a loan-book total, not a shared treasury. Totals are computed only in an authorized context.
- On mobile, access, identity and the next action come before introductory artwork.
- The static "Your private desk" panel is replaced.

## Epic 24. Desk MVP completion (Stage 4)

### Story 24.1. Auditor consent

Acceptance:

- For desk loans, named auditors and their scope are shown at signing, and both parties consent once to that audience.
- Adding a reader to an existing loan needs new consent. Removing one revokes future access. Chat, rejected proposals and raw income proofs stay excluded unless separately shared.
- Non-desk loans keep selected-loan disclosure grants. Before this story starts, Devnet evidence shows permission members can change after creation and that read-only members cannot see balances.

### Story 24.2. Complete private portfolios

Acceptance:

- My loans includes the wallet's authenticated private borrowing and lending positions, read with its own private sign-in.
- Public and private totals are named separately. Locked or unavailable private data never appears as zero.

### Story 24.3. Alerts and reminders

Acceptance:

- Alerts fire after 25%, 50% and 75% of the initial collateral-price buffer is used. The absolute remaining buffer is shown, with escalation at 5%, 2% and liquidation eligibility.
- The baseline is rebased after a confirmed principal reduction or collateral addition, using the next valid price. Alerts are deduplicated and have recovery hysteresis.
- Reminders cover maturity, grace end, the priced-recovery window and the terminal-claim time.
- Telegram is linked by wallet consent and a one-use bot link. Private notifications are generic. Monitoring receives only the deadlines and risk bands the user separately authorized.

### Story 24.4. MoneyGram sandbox cash-out

Acceptance:

- Cash-out is offered after a confirmed USDC receipt or from an available balance, using server-created sessions, the hosted widget, and reviewed signing that checks network, mint, amount, recipient and payer.
- The Ramps transaction id and `mgiTransactionId` are stored. The Ed25519 webhook signature is verified over the documented timestamp, host and unmodified body for the right environment, with replay protection and deduplication.
- Reconciliation uses `GET /v1/transactions/{id}/status?sync=true`. Funds received, pickup ready, paid out and refund states are distinct.
- Coverage and quotes come from the provider. A sandbox reference never implies real cash availability. Borrowers in cash-out-only countries are told they need USDC to repay. The screen says this step is not private.
- Tests cover unsupported mints and networks, rejected signatures, uncertain transactions, forged and replayed webhooks, reconciliation and refunds.

### Story 24.5. Gate metrics

Acceptance:

- A dashboard counts activated desks, confirmed loans per desk, originations without developer intervention and returning lenders, excluding the developer wallets from 19.1.

## Epic 25. Customer gate (Stage 5)

### Story 25.1. Two-week observed lender pilot

Acceptance:

- Five independent lender operators have activated desks, and at least 80% originate without developer intervention after onboarding.
- Ten confirmed loans across three desks, with three lenders returning for another loan. Developer-generated activity does not count.
- Participants pass the comprehension check from 19.1. No critical custody, authorization or settlement defect is unresolved.
- If the gate fails, activation and workflow fixes come before Epic 26.

## Epic 26. Expansion (Stage 6, pulled forward 2026-10-07)

The owner waived the Epic 25 gate on 2026-10-07. Each story ships behind its own `NEXT_PUBLIC_*_ENABLED` flag and a capability entry in `app/lib/capabilities.ts`, in the V2 programs only, following [research.md § Expansion rules](research.md). Program changes to `isolated_loan_v2` go through the Squads vault and its 24-hour time lock.

### Story 26.1. Refinance and rollover

Acceptance:

- `refinance_into` on `isolated_loan_v2`, signed by the borrower, settles the old loan for exactly its payoff from the new principal plus the borrower's contribution, moves collateral vault to vault and opens the new loan, atomically. `new_principal > payoff` is rejected.
- Only Active and Grace loans refinance. The old loan ends `Refinanced`, never `Repaid`. A renewal offer restricted to the same borrower covers same-lender rollover.
- `private_loan_v2` refinances inside one rollup domain with fresh consent and auditor hash on the new terms.
- LiteSVM: refinance racing repay and liquidation yields exactly one terminal state; contribution and cash-out rejection; a restricted renewal rejects other borrowers. Devnet evidence for one public and one private refinance.

### Story 26.2. Per-asset collateral and jitoSOL

Acceptance:

- `isolated_loan_v2` gains a governance `Config` and a `CollateralConfig` per mint, written only by the Squads vault. Canonical wSOL keeps its constants; existing loans are unchanged.
- `loan-core` reads any configured feed with every existing owner, verification, age and band check. Tests prove a foreign owner, wrong feed and stale price are still rejected.
- jitoSOL (test) on Devnet at 60% / 70%, priced by JITOSOL/USD posted in the same transaction. The Jito logo appears only in asset selection.
- Devnet evidence: config written through a Squads proposal and one jitoSOL loan through repayment.

### Story 26.3. Automation mandates

Acceptance:

- Borrowers create, revoke and inspect one top-up or repay mandate per loan, bound as in research. Only `Config.keeper` executes; every bound is checked on-chain.
- The Convex job `mandate-execute` runs public mandates; private mandates run in the rollup watcher, never in Convex. An originations pause never stops a mandate.
- LiteSVM: cap, fee cap, expiry, hysteresis, wrong keeper, revoked delegate, and a mandate after settlement all fail closed.

### Story 26.4. Private liquidation operations

Acceptance:

- The private liquidation pool admin can rotate quote parameters and drain unused liquidity through governance; watchers rebind when a position changes hands.
- Private settle tests cover a quote racing repayment and a rebind after transfer.

### Story 26.5. MoneyGram cash-in

Acceptance:

- "Fund this repayment with cash" lands Devnet USDC in the borrower's wallet through MoneyGram's sandbox. Repayment stays a separate, signed step.
- The step says it is not private before it starts. Forged, replayed and wrong-mint deposit webhooks are rejected; refunds are handled.
- Capability `cash-in` follows `NEXT_PUBLIC_MONEYGRAM_CASH_IN_ENABLED`.

### Story 26.6. Shielded deposits and withdrawals

Acceptance:

- A one-day spike records which Devnet mints Umbra and Privacy Cash support. Shielding is enabled per provider and mint only after that support and a full recovery test (shield, clear storage, recover, unshield).
- Shielding is a wallet step before deposit or after withdrawal; ZenLo's loan mint does not change. Viewing keys stay on the device with the narrowest scope; a test proves none reach Convex, telemetry or exports.

### Story 26.7. Credit: history, credentials, income proofs and the invited pilot

Acceptance:

- A borrower can read and export their own private repayment history, built from rollup receipts.
- A credential issuer in `Config` writes SAS attestations with only tier and expiry. Reclaim income proofs are verified server-side and discarded.
- `accept_offer` allows the tier's max LTV (80% / 85% / 88%) with a valid credential, fixed on the loan at origination. The pilot is invite-only.
- Tests: expired, revoked, wrong-issuer and wrong-borrower credentials fall back to the standard caps.

### Story 26.8. Secondary market and activity export

Acceptance:

- `list_position` and `buy_position` sell a V2 position atomically; the buyer becomes `current_lender` and receives every later payment. Settlement voids listings. Private positions transfer inside the rollup with the reader permission swapped.
- Every loan review says the position may be sold.
- Activity export as specified in research, with replayable public cursors and browser-only private rows.

## Epic 27. Advanced privacy (Stage 7, research only)

- Confidential settlement and Arcium computations stay research-only until a paying desk shows a concrete need and asset compatibility, redemption, custody, liquidation and recovery are proven.
