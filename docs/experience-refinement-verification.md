# ZenLo experience refinement verification

Refinement tracking is separate from the completed sprint stories. Scope: `_bmad-output/implementation-artifacts/spec-zenlo-experience-refinement.md`.

## GitHub release record

The implementation is [commit `81215bd`](https://github.com/tantshirt/isolated-fixed-term-lending/commit/81215bd8274f724ce8b732470fc20f1553e0d58f), which reached `main` before the follow-up pull request was requested. The follow-up PR records that existing implementation and its verification; its diff does not reapply the application changes.

All 18 generated production images are tracked under `app/public/illustrations/zr-*.webp`. The landing page uses `zr-hero.webp`, ribbon story art and the private-room set; use cases and empty states use the rest of the same set. Source PNGs remain ignored local files under `docs/brand/originals/`, as intended. The small brand mark and favicon remain unchanged.

The GitHub production deployment for `81215bd` completed successfully. On 2026-10-06, the HTML served by `https://zenlo-loans.vercel.app` referenced the new `zr-*` images and `/learn`, with no old `zl-*` illustration references on the landing page. This confirms the web release, not deployment of the updated Solana program.

## Implemented

- Satin ribbon art replaces active pebble illustrations; the small mark and favicon are unchanged. The hero is the style reference for the coordinated set. Source originals remain local and ignored; optimized WebPs, prompts and receipts are retained.
- All 18 generated assets were inspected together for material/palette consistency; receipts record 180 credits, with 18 source originals retained locally.
- Hero artwork pauses on request, offscreen, in hidden tabs and for reduced motion. Three ending diagrams explain the direction of funds without moving figures or controls.
- Learn has a wallet-free entry and a Devnet Loan Lab route. Old Private Lab links redirect. Create offer remains reachable from Offers and its original URL.
- Private opens onto rooms and invitations after verified entrance; owned rooms surface real join-request counts. Balances remain contextual and old step links work.
- Rooms expose visibility boundaries, member roles, next steps, proposal revisions, private balances and receipts. Failed reads and access changes close content and require recovery.
- Liquidation reads distinguish checking, no open quotes and unavailable data. Before signing, a fresh quote must match the reviewed revision/amounts and current funding or ticket eligibility.
- Copilot distinguishes availability states, offers applicable tasks, selects a loan when needed, preserves exact-text consent and revision binding, and keeps results draft-only. Changed requests/revisions mark answers stale.
- My loans reports unverified cached data, uses ordinary accessible toggle buttons, and avoids a false “None” deadline during loading. Discover exposes reset filters, prevents failed reads from appearing empty and retains visible reduced-motion defaults.

## Checks

- Client unit tests: 89 passed at the first integration checkpoint, including fresh quote funding/refund eligibility regressions. Later coordinator security work adds its own tests.
- TypeScript: passed after final UI changes.
- ESLint: passed without errors or warnings after final UI changes.
- `scripts/refinement-check.mjs`: passed ten routes at 390, 820 and 1440 pixels with reduced motion, no horizontal overflow or page errors. Also verifies wallet-free Learn makes no configuration/price/RPC requests, legacy Lab redirect, navigation, every displayed generated image decodes, hero pause/offscreen behavior, and a forced Discover read failure shows unavailability instead of an empty market.
- Existing `scripts/browser-check.mjs`: passed simulation repayment/liquidation/expiry, authority/deadline errors, reload, corrupt and blocked storage, deep links, keyboard and responsive routes.
- The coordinator reported a successful production build; its security changes will receive a separate final build.
- Browser screenshots are local `/private/tmp/zenlo-refinement-*`. Render inspection caught and fixed a reduced-motion hydration mismatch and insufficient contrast in the new Learn card.

## Verification limits

Unauthenticated browser checks cover landing, use cases, Learn, Offers, Discover, My loans, Private entrance, Loan Lab, Liquidations entrance and invalid room recovery. Authenticated rooms, session revocation, wallet signatures and live liquidation transactions require coordinator verification with real Devnet identities. Unit regression coverage verifies quote freshness, exact expiry boundaries and own-ticket eligibility; it does not claim a Devnet transaction occurred.

The coordinator owns the final production build, repository-wide security scan, program tests and fresh Devnet transaction verification. No deployment is performed by this implementation handoff.


## Coordinator security and recovery verification

- Public loan LiteSVM: 15 passed; loan-core Rust math: 5 passed; TypeScript math/PDA checks passed.
- Rebuilt private SBF: 11 settlement regressions and 4 AI-claim/first-draw regressions passed.
- Actual AI worker tests verify claim-before-spend, a single concurrent winner, no spending after uncertain/rejected claim confirmation, and bounded provider attempts.
- Actual private transfer sender regression confirms receipt persistence before a lost network response. Receipt reconciliation keeps unknown confirmations unresolved, records failures and preserves commit state.
- Controlled browser tests execute the actual `usePrivate` hook and Loan Lab: wallet changes during pending and completed sign-in, disconnect, pending-round reload, resumed polling, no duplicate first sponsorship, and read-failure fallback passed.
- Controlled slow-read polling tests verify completion and cleanup. AI availability HTTP failures propagate and can recover.

All 104 client tests, production build, TypeScript and lint passed after review corrections. A fresh Devnet cycle was rate-limited before completing the loan flow; temporary assets were returned and its temporary key removed. Updated program instructions have not been deployed; prior hosted evidence does not validate this new release. Remaining upstream dependency advisories and incomplete repository-wide security coverage are documented in the local audit artifact. No public sharing or deployment was performed.
