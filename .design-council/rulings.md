# Lendspan design rulings

These decisions record the user's approved brief and the council discussion, not independent user research.

| Decision | Applied argument | Reason |
| --- | --- | --- |
| Inter for words and tabular figures | Kestrel / Plumb | User explicitly requested familiar, professional typography. Council font bans do not override that. |
| White, cool neutrals and blue actions | Kestrel | Full identity reset was selected. Tenor's ivory/green/brass system is superseded. |
| One loan across both perspectives | Sally / Fovea | Beginners can follow amounts and consequences without learning a dashboard first. |
| Editable defaults plus advanced details | Fovea / Sol | Help beginners decide while retaining precise terms for experienced users. |
| Animated fund movement on landing | Ravi / Nils | Motion explains the exchange; native scroll and visible defaults preserve access. |
| Short state feedback inside the product | Nils | Repeated actions should feel immediate; no looping financial counters or delayed controls. |
| Simulation plus genuine Devnet | Plumb / Hollis | Simulation is repeatable and wallet-free. Real transactions use real time, price and authority. |
| Devnet liquidation is conditional | Plumb | No fake price updates or relaxed oracle checks to force a presentation outcome. |
| Lendspan | User / Kestrel | Replaces Pact after a direct blockchain-lending name collision was found. |

Source methods restored from the pinned upstream repositories; actual verification results belong in the implementation report. Missing coverage must be stated, not inferred from a polished screen.

## Phase 1: private lending screens (2026-10-05)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| The current journey step drives the page; its panel gets the accent ring | Ravi / Sol | Equal-weight white cards read as blocky and give no next step. |
| On phones, actions come first; the journey follows, with a compact "Step n of 6" above the actions | Indigo / Ravi | At 390px the six-step rail pushed every control below the fold. |
| Locked panels stay crisp and state why they are locked; no translucent dimming | Nils / Fovea | Opacity reads as broken. The design brief requires actionable reasons for disabled actions. |
| "Then" for built-but-not-yet-reachable steps; "Phase 2" notes only for unbuilt work | Sol | "Coming" suggested working features were unbuilt. |
| Non-amount text never uses the figure style; reset `dd` margins | Plumb | "Sign in to see" was set like money and indented by the default `dd` margin. |
| The proof page's next list comes from the evidence file | Wren / Plumb | The hard-coded list was out of date as soon as 9.3 passed. |

## Phase 2: private loan in the room (2026-10-05)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| Loan cards lead with "receives", "repays", collateral, and deadline, then the role sentence | Sol | Money and risk first, matching the public loan page. |
| Private actions reuse the public action words and the exact expiry sentence | Sol / Fovea | One vocabulary across public and private loans. |
| Program errors are translated (stale price, revision changed, LTV, deadline) | Fovea / Plumb | Members see error names, but beginners need the next step. |
| Room side column widened to 24rem for the loan form | Indigo | 20rem squeezed amount inputs and the summary grid. |
| Signed-in loan states not screenshot-verified | Plumb | Headless runs cannot sign a TEE login. Recorded as missing coverage, not inferred. |

## Phase 3: discovery and copilot (2026-10-05)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| Unshared card fields read "Not shared" in a muted style | Sol / Indigo | They looked like values; the card should show what was withheld, not imply it. |
| Each card starts with "Borrower request · room abcd" | Ravi | Cards without a header read as unexplained data. |
| The copilot shows the exact excerpt, model, and identifiability warning before the wallet signs | Fovea / Plumb | Disclosure must be informed. Redacting addresses does not make exact amounts anonymous. |
| A stale AI answer stays visible, tinted, with no "Use as a draft" | Plumb | A late answer can inform but must not change the current draft. |
| Comparison highlights the cheapest repayment only | Sol | One clear figure, not a ranking that implies advice. |

## Phase 6: landing, use cases, footer (2026-10-05)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| Use cases follow chainpay's "I want to… → Start here" table, linked to illustrated case cards below it | Sol / Wren | A quick index plus one detailed telling of each case; the first draft repeated every intent twice. |
| Case cards alternate image and text; the two text-only cases span full width | Ravi / Indigo | Rhythm without inventing filler art for cases that do not need it. |
| The private chapter moves into place but is never hidden before scrolling | Nils | Content must be visible by default; opacity-0 reveals failed full-page captures and no-JS readers. |
| New illustrations reuse the cobalt satin and porcelain series and its prompt grammar | Kestrel / Wren | Same identity across public and private stories; no text or logos in images. |
| The footer lists Try it, Private, and Learn, with a Devnet and no-guarantee note | Sol / Fovea | Replaces the two-line inline footer; every new surface is reachable without the header. |

## Phase 5: loan lab, diagnostics, private balance polish (2026-10-05)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| The lab reads as three named steps (Draw, Make your call, See why) with recording shown as a separate optional step | Sally / Ravi | One plain panel with no step cue read as a quiz card, not a guided workflow. |
| The no-wallet lab state shows the steps and a Connect action, never a sample scenario | Sol / Plumb | A canned scenario would look like a VRF draw. Fovea wanted a preview; overruled to avoid a fake result. |
| After answering, focus moves to the result and right/wrong pills carry words ("Your call", "Answer") | Fovea | Measured: disabling the fieldset dropped focus to `BODY`. Red/green alone breaks the status-words rule. |
| "Read the line" stays post-answer, correct-only, behind an explicit button with the no-advantage sentence | Sol / Plumb | Meets 13.1: opt-in and no loan advantage. The no-advantage sentence stays visible while the badge is being recorded. |
| Wallet rejections use the shared `messageFromAnchorError` wording on private and lab surfaces | Plumb / Fovea | BalancePanel and LabPage printed raw wallet errors; Phase 2 ruled that errors must be translated. |
| Wallet-specific messages and send drafts clear on signer change; token switch clears the send amount | Plumb | Design brief: clear old success messages on wallet switch. A typed "5" must not silently turn from USDC into wSOL. |
| Diagnostic warnings use the yellow status tokens and show visible status words | Kestrel / Fovea | `--color-brass` now resolves to primary blue, so "needs attention" looked like an action. The status was screen-reader-only. |
| Addresses inside diagnostic details and the SOAR receipt use mono; "Private until you sign in" drops `.num` | Kestrel / Indigo | Mono is for addresses only; non-amount text never uses figure styling (Phase 1). |
| The USDC/wSOL switch is a compact segmented control, not two full-width boxes | Indigo / Ravi | Two 50% bordered boxes read as blocky. Nils: no sliding thumb animation, an instant state change is enough. Unresolved: Ravi wanted the thumb. |
| Lab figures derive from `scenarioFrom` constants, not literals in the JSX or explanation copy | Plumb | "1.1 wSOL at $150", "5%", and "80%" are duplicated, so changing a constant would leave wrong copy. Low priority. |

Coverage note: signed-in balance and the real VRF/SOAR round-trip were not screenshot-verified (headless browsers cannot sign). The `zz-lab-preview` harness must be deleted before commit.

## Final council: whole product (2026-10-05)

Evidence: final 390/820/1440 captures plus live checks on the dev server (computed styles, target sizes, console). The final captures were taken with reduced motion on, which exposed the first finding.

| Decision | Applied argument | Reason |
| --- | --- | --- |
| Restore the reduced-motion block in `private.module.css` to `transition: none` only; the stray `.heroLinks`/`.secondaryLink` copies go | Plumb / Fovea | Measured: with `prefers-reduced-motion: reduce`, `.panel` and `.stepMarker` compute `display: flex` (default: `block` / `grid`). Panels wrap their headers sideways and step numbers sit off-centre, so reduced-motion users get the blocky private page Phase 1 ruled out. Introduced by a misplaced Phase 3 insert. |
| The proof summary may not say "Private loans: Not open yet" while its own evidence list marks 10.1 "Proven on Devnet" | Plumb / Sol | Two claims on one page contradict each other; the evidence file wins (Phase 1 ruling). |
| Every Devnet and simulation route carries the shared footer | Sol / Kestrel | Phase 6 ruled every surface reachable without the header; the footer currently renders only on `/` and `/use-cases`. |
| The loan lab belongs to Private: breadcrumb "Private / Loan lab" and the Private tab marked current | Sally / Ravi | It is entered from the private home, but its breadcrumb says Devnet and no tab is active, which breaks landing → private → lab continuity. |
| The proof page gets the same breadcrumb and pill eyebrow as its siblings | Indigo / Kestrel | It is the only private route with an uppercase eyebrow and no breadcrumb. |
| The setup bar keeps the page gutter at tablet width | Indigo | At 820px `.setup` runs edge to edge with rounded corners, out of line with the header and content gutters. |
| Lab figures use `.num`; `.tabular` is not a defined class | Indigo / Plumb | Four lab values silently lose tabular figures. |
| Small inline links on private, landing and footer reach 44px tap height on touch | Fovea | Measured 17–24px. Passes the WCAG 2.2 AA spacing exception, but PRODUCT.md sets 44px targets. Fix with padding, not larger type. |
| "Use Devnet" loses the ↗ | Sol / Kestrel | It is an internal route in the same tab; the arrow promises an external link. |
| Earlier rulings verified as honored: no colour literals in component CSS, lab figures derive from `scenarioFrom`, the `zz-lab-preview` source is gone (only a stale `.next` artifact remains), status pills carry words | Plumb | Checked in source. |

Coverage note: signed-in states remain unverified (unchanged). The "1 issue" dev overlay on the landing capture did not reproduce; the console is clean on `/`, `/use-cases`, and `/devnet/lab`. Desktop private-chapter images were blank only because full-page capture skipped lazy loading; the 820px capture shows them.

## Private refactor A: section tabs (2026-10-05)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| Private sub-pages get a tab strip (Overview, Discover, Liquidations, Loan lab) on every private route | Sally / Fovea | The five hero links read as footnotes; the user said the sections were hidden. |
| Diagnostics and Proof sit in a smaller trailing group after a divider | Ravi / Sol | They are reference pages, not steps in a loan; equal weight would crowd the four working tabs. |
| The strip sits inside the 1040px page column with a hairline, not a full-bleed bar | Indigo | A full-width bar under the boxed wallet card broke the column edge. |
| The active tab scrolls into view on phones; the "Private" label hides under 720px | Fovea / Indigo | At 375px "Loan lab" was off-screen with no cue that it was selected. |
| Loan lab moves to `/devnet/private/lab`; `/devnet/lab` redirects | Hollis | One layout owns the tabs; old links keep working. |
| Breadcrumbs are removed from tab pages; the room keeps "Overview / Room abcd" | Sol | Tabs already say where you are; a room is not a tab, so it keeps its way back. |

## Private refactor B: Overview as a stepped flow (2026-10-05)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| Overview shows one step at a time (Sign in, Room, Fund, Terms) using the Create wizard's kicker, dots and question heading | Sally / Indigo | Five equal panels plus a six-step rail was "a lot going on"; Create is the pattern the user already likes. |
| Steps unlock from real state, not from Continue; the URL keeps `?step=` | Plumb / Hollis | A step cannot claim progress the wallet has not made; deep links still work and fall back safely. |
| Terms is readable before sign-in and explains propose, compare, commit, and the three endings | Sol / Fovea | The user could not tell how private terms worked. The rules should be clear before a wallet is involved. |
| A blocked step shows a reason and "How terms work", never a dead Continue button | Fovea | Disabled buttons need an actionable reason (design brief). |
| Funding is skippable; the "What stays private" grid moves into a sticky "Your private desk" aside | Ravi / Sol | Funding is not needed to read or join a room; privacy facts are reference, not a step. |
| Recent activity is collapsed below the flow | Ravi | Receipts are history, not the next action. |

Coverage note: signed-in steps 2–4 were not screenshot-verified (headless browsers cannot sign a TEE login). Signed-out steps 1 and 4 were checked at 375 and 1280px with no horizontal overflow.

## Private refactor C: loan terms wizard in a room (2026-10-05)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| "Propose a loan" opens a four-step wizard (Borrower & amount, Rate & term, Collateral, Review) over the room, with "Back to room" | Sally / Indigo | The one-shot form squeezed into the 24rem side column and never explained the terms. |
| The collateral step reuses the public `HealthMeter` (70% max, 80% liquidation, SOL price at the line) plus three plain rules: LTV, liquidation, expiry | Sol / Fovea | Same picture as the public offer page; beginners see what each number means before committing. |
| Interest copy says "a flat amount, not yearly" and states the exact USDC interest | Plumb | A bare percentage reads as APR. |
| Review mirrors Create's sentence + editable term list, and says proposing moves no money and needs two signatures | Sol / Plumb | One vocabulary with the public wizard; no surprise wallet prompts. |
| Sticky "Borrower's view" aside shows receives, repays and locks live | Ravi | Mirrors Create's live summary so the lender sees the deal from the other side. |
| Each step's Continue is disabled with its reason (borrower, amount, 0–20%, LTV ≤ 70%) | Fovea | Same rules as the old form, surfaced per step instead of a silent disabled submit. |

Coverage note: verified through a temporary preview harness (deleted before commit) at 375 and 1280px, all four steps, no horizontal overflow. The live propose round-trip was not re-run (headless cannot sign a TEE login); `proposeLoan` and its arguments are unchanged.

## Discover marketplace, Epic 14 (2026-10-06)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| Discover splits first by side (Borrowers asking / Lenders offering), then venue (Public / Private), both kept in the URL | Sally / Hollis | One place for both sides of the market; deep links and Back keep working. |
| Private lenders get an explanation and two ways forward, never an invented listing | Sol / Plumb | Private lender terms live in sealed rooms; a fake row would claim data that does not exist. |
| The live badge says Live / Refreshing every 15 s / Devnet unreachable in words, tone second | Fovea / Kestrel | Status needs words; an unreachable network is not an empty list. |
| Filters keep cards with withheld fields and sort them last | Plumb | Hiding a card for a withheld field would penalise privacy and imply a value. |
| The request wizard starts with public or private, then reuses Create's four steps from the borrower's side with a Lender's view summary | Sally / Indigo | Step zero from the brief; one wizard vocabulary for lending and borrowing. |
| Wrapping SOL is its own button; posting stays disabled while the wallet is short of wSOL | Plumb / Fovea | Wrapping is never a silent step inside posting. |
| The fund panel says before the click that a stale price means a fresh price post and extra signatures | Plumb | Oracle refresh signatures are announced, not a surprise. |
| Request terms say "Term, from funding" and "Max LTV at funding" | Sol / Plumb | The clock and the LTV check both start at funding, not at posting. |
| Under 860px, offer and request rows show their labelled figures below the amount | Fovea / Sol | Phones keep the figures needed to decide before tapping. |
| List and status transitions are 0.2 s with no layout animation on rows | Nils | A 15-second refresh must not make the list shift. |

Applied council findings: native button reset on the explainer, labelled row figures on phones, translated wallet errors on Ask to join, `num` only on figures, 44px link targets, 0.2 s transitions. Coverage note: Playwright at 390, 820 and 1440px on all Discover views, the request page and the wizard, signed out. Signed-in funding was not run in a browser; Devnet funding is proven by the smoke script (see [devnet.md](../docs/devnet.md)).

## LegitShark rebrand kickoff (2026-10-06)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| The product is renamed LegitShark (`legitshark.sol` was unregistered on mainnet on 2026-10-06) | User / Kestrel / Ravi | A "wait, what?" name with an honest payoff. `loanshark.sol` and `sharky.sol` are taken, and sharky.fi is an existing Solana lending protocol, so "Sharky" cannot be the product name. |
| The mascot is Sharky: flat head, one dorsal fin on the back, legs and no tail; public look is a cobalt polo, gold chain and white slacks (Miami, not a business suit), soft 3D | User / Indigo | One character carries the story: there are bad loan sharks; here every term is on the table. |
| Sharky supersedes the cobalt satin and porcelain series (Phase 6 ruling) for all illustrations | User / Kestrel | Every asset is redrawn with Sharky. There is still no text and no logo inside generated images. |
| Sharky never appears inside a figure readout, a risk warning, a signing control or a liquidation state; story art beside explanatory copy is allowed | Plumb / Fovea | He hands over the term sheet; he is never the term sheet. Humor stays out of money decisions. |
| Mouth is a closed smirk or a grin with rounded teeth; never a jagged snarl, blood or menace | Kestrel / Sol | Humor without looking like a scam. |
| The private chapter uses a PI variant: fedora, round glasses, trench coat, magnifying glass, noir posture, brand palette | User / Indigo | Private rooms read as a discreet investigation, not a dark-canvas theme. |
| One hero entrance (≤ 250 ms rise and fade), then Sharky holds still; no idle loops | Nils | A fidgeting mascot next to an APR reads as a slot machine. The scroll story stays as it is. |
| The landing hero states the joke once, then plain English | Fovea / Sol | A beginner must read "transparent fixed-term loan" within five seconds. |
| Each use case gets its own pose showing a different job | Ravi / Wren | The use-case section was the weakest on the page; five waving Sharkys would be filler. |
| The logo is the Inter wordmark "LegitShark" in code plus a Sharky-head mark | Kestrel | Generated images never contain text; the mark must read at 16 px. |
| On-chain program name, crate, PDA seeds, package names and `--tenor-*` token names do not change | Hollis / Plumb | The rebrand is display-only; renaming seeds would break deployed Devnet accounts. |

Phase 1 review (Kestrel / Indigo / Plumb / Fovea): the wordmark and 34 px head pass at 1440 and 390 px. The 19 poses hold identity, and the banker's-lamp green is accepted as a single prop. The IDL description stays "Lendspan" because on-chain metadata is out of scope. The 2K PNG originals stay local, and compact WebP masters are committed.

## LegitShark phase 2: landing (2026-10-06)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| The hero reads "Yes, a loan shark. A legit one." Sharky stands on a soft accent stage next to an HTML term-sheet card | Ravi / Sol | The joke and the proof sit in one screen. Figures stay in HTML beside Sharky, never in the image. |
| "About the name" runs right after the hero: four "Other sharks / Sharky" rows of mechanics | Sol / Plumb | Every claim maps to program behaviour: fixed terms, one full-term fee, a per-loan vault, an enforced deadline. |
| The scroll story is unchanged; Sharky poses replace the abstract art in chapters 2 and 3 | Nils / Ravi | The user asked to keep the scroll animation. |
| The private chapter becomes "Sharky's case files", with the PI poses shown uncropped | Indigo | The noir framing marks the private side; contain-fit keeps the wide room scene whole. |
| Use cases change from a table to six cards: image, Public/Private tag, intent, one-line hook, start link | Ravi / Wren | The user called the use cases weak; each card shows a different job. |
| On phones, contrast cells carry visually hidden "Other sharks:" / "Sharky:" labels | Fovea | Column headers are hidden on phones. |

## LegitShark phase 3: app surfaces (2026-10-06)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| Discover's venue explanation is spoken by Sharky in a speech bubble: the guide pose in public, the PI head in private | Sol / Fovea | Same facts, now carried by the character; `aria-live="polite"` announces changes when a chip is switched. |
| Empty lists show waiting Sharky; network errors, not-found pages and the error boundary show confused Sharky; "private lenders stay unlisted" shows the PI | Wren / Kestrel | Mascots replace the progress ring in states that have no progress. |
| The wizards get one Sharky tip per step under the preview, never inside it, with no figures | Plumb | The preview is a figure readout, so Sharky sits beside it. |
| `LogoMark` stays the progress ring and transaction spinner | Hollis | It carries state, not brand. |
| Private home shows PI Sharky in "Sharky's office" | Indigo | Marks the private side without a dark canvas. |
| The `lendspan-*` abstract WebPs are removed from `public/` | Kestrel | No page uses them. |

Open item (low): the "Request unavailable" network state on request detail is still text-only. Closed in the final review: both the offer and request "unavailable" states now use the confused-Sharky layout.

## LegitShark final review (2026-10-06)

The full council reviewed `/`, `/use-cases`, Discover (all four side/venue views), both wizards, private home, not-found and error states, and `/demo` at 1440 and 390 px. The only open item, text-only "unavailable" states, is fixed.
- **Accepted as is:** `/demo` keeps no mascot. It is a figures-first simulation, and Plumb's rule keeps Sharky out of readouts.
- **Not covered:** a signed-in wallet run after the rebrand. Wallet code was not touched.

## ZenLo rebrand, phase 1: foundation (2026-10-06)

The user retired LegitShark and Sharky and chose **ZenLo** from a naming board, then picked the mark, type and art direction on a brand board and approved the design canvas (https://claude.ai/artifact/5gGPGh4BdF71k8b8vCzapD). This section supersedes the LegitShark rulings above wherever they mention Sharky, the shark name or Inter.

| Decision | Applied argument | Reason |
| --- | --- | --- |
| No mascot; the mark is a pebble crossed by a wave | User / Kestrel | The user rejected mascots (shark, ghost, animals) as off-brand or too close to Phantom. One abstract mark reads at 16px and doubles as the favicon. |
| Nunito replaces Inter, with heavy 800–900 headings | User / Indigo | The user chose "Font 4" for a rounded, friendly-premium feel, closest to the Phantom-like vibe they asked for in blue. |
| Navy `#0f1f4b` becomes ink; cloud and sky tints join the palette; radii grow to 14/24px | Indigo / Hollis | Matches the approved canvas while keeping the existing blue and every semantic token name. |
| Navy panels mark private features | Sol / Fovea | Private must look different from public without a dark canvas; navy keeps contrast high. |
| Art is soft clay pebbles and shapes on calm water, generated from the approved stack image as the only style reference | Wren / Ravi | One reference keeps sixteen images consistent. Figures, risk and signing controls stay in HTML, never beside art. |
| The rename is display-only | Hollis / Plumb | Programs, IDLs, seeds, storage keys and `--tenor-*` names stay, so no deployed account or saved state breaks. |

## ZenLo rebrand, phase 2: landing and use cases (2026-10-06)

Reviewed `/` at 1440 and 390 px and `/use-cases` at 1440 px against the approved canvas.

| Decision | Applied argument | Reason |
| --- | --- | --- |
| The hero is copy plus the balanced pebble stack; the example term sheet leaves the hero | Ravi / Plumb | The figures live in the story tracker and the endings. Art never sits beside figures. |
| "Most loans hide the ending. Ours prints it first." replaces the shark contrast: a muted card of usual-loan habits beside a blue card of ZenLo mechanics | Sol / Kestrel | Same four mechanics as before, without the shark joke the name no longer makes. |
| The scroll story keeps its tracker, ids and figures; chapters 2 and 3 use the new exchange and settle art | Nils / Hollis | The user asked to keep the story and workflow; `landing-check.mjs` still passes unchanged. |
| The landing shows three use cases (two private, one public) and a "See all 6 use cases" button | User / Wren | The user found six cards on the landing too much; a snippet sends people to the full page. |
| `/use-cases` gets All, Private and Public filters and two-column cards with the hook in blue | Ravi / Fovea | Filtering is the fastest way to find your job; `aria-pressed` and `aria-live` announce the change. |
| Private steps and tags use navy | Indigo | Navy marks private everywhere, matching the canvas. |
| On phones the header keeps only "Try the demo" | Fovea | Two pills wrapped onto two lines at 390 px; the hero repeats "Use Devnet". |

## ZenLo rebrand, phase 3: app without Sharky (2026-10-06)

Reviewed Discover, Offers, the create wizard, the request venue choice, a closed offer, private home and the demo at 1440 px.

| Decision | Applied argument | Reason |
| --- | --- | --- |
| `Sharky` and `SharkyTip` are deleted; `Spot` (waiting, notFound, private, success) and a plain `Tip` callout replace them | Kestrel / Plumb | Same placements the old rulings allowed (empty, missing and error states, beside wizard summaries), never inside readouts. |
| The create and request wizard summary is a navy card | Indigo / Fovea | Matches the canvas "Borrower's view"; tokens are remapped inside the card so every figure keeps its contrast. |
| Private home opens on a navy hero with the two-pebble image | Indigo / Sol | Private reads as private at a glance without a dark canvas. |
| The request venue choice shows two image cards; Private is navy | Ravi / Wren | The choice is visual and matches the landing's private chapter. |
| Buttons, chips and the app nav are pills; containers are 20–24px; Nunito weights move to 800 | Hollis / Indigo | One shape language across landing and app, done in tokens and modules, not per page. |
| Error copy is "That page didn't load." | Sol | Plain words, no mascot joke. |

## My loans (2026-10-06)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| A remembered wallet is the account: `/devnet/me` is the returning user's home, and the header gains "My loans" with an attention count | User / Sol | The user asked for people to keep coming back and manage everything without a sign-up. |
| Rows are ordered by urgency, not by date: past due, past the line, due within a day, near the line, running, open, settled | Plumb / Fovea | A lender with five borrowers sees the one that needs them first. Each tier names the action in words, not color alone. |
| Rows link to the existing offer and request screens for every action | Hollis / Plumb | Signing stays in one audited place; the dashboard never duplicates transaction code. |
| Running loans get "Add to calendar" with a reminder 23 hours before the last second | Sol | No backend sends reminders; the person's own calendar does. |
| Public request rows show "Fund this request" to other wallets and "Your request" to the borrower | Wren | Lenders see where they can act straight from Discover. |

## Rooms and invites (2026-10-06)

| Decision | Applied argument | Reason |
| --- | --- | --- |
| Invitations appear on Private home and My loans as a navy panel: room, your role, who invited you, Open or Dismiss | Sol / Fovea | Invitees used to need a link sent outside the app; now the rollup tells them. Navy keeps it private-coded. |
| A non-member sees "Ask to join" and a way back to private requests; a half-created room shows "Finish setting up" to its creator | Plumb / Sol | Every dead end now has a next step that matches what the program allows. |
| The owner picks Lender, Borrower or Viewer when letting someone in, and can dismiss requests | Plumb | The program supports all three roles; the old button only offered lender. |
| Funded private bids say "waiting for the borrower" and explain how to cancel, never "lost" | Plumb / Hollis | Only the borrower can read which offer won; the interface does not claim what it cannot know. |
| Rooms list by role (Owner, Lender, Borrower, Viewer) and come from the rollup, so they follow the wallet across devices | Indigo / Hollis | Local storage alone lost rooms on a new device. |

## ZenLo final review (2026-10-06)

The full council reviewed every route at 390, 768 and 1440 px (14 routes, no horizontal overflow, no page errors, no shark text), plus `/devnet/me` signed out, with a wallet, and with the private desk. A scripted Devnet run (`app/scripts/cycle-smoke.ts`, evidence in `docs/devnet-cycle-evidence.json`) passed 12 of 12 checks across a public offer, a public request that expired and was claimed, and a private room with an invitation found by listing and a bid that both sides can see.

- **Fixed during review:** cancelling an unfunded private bid failed for a lender with no private balance (`InvalidWritableAccount`); drafts now pass the loan's own USDC account, which the program never reads for a draft.
- **Accepted as is:** a lender cannot see that another offer won a room. Only the borrower can read the deal record, so funded bids explain how to cancel instead of claiming a result.
- **Not covered:** a human wallet signing on a phone after the rebrand, and the AI copilot in a room. The code paths are unchanged.

## Repayment rules V2 (2026-10-07)

Reviewed at 390, 820 and 1440 px: Learn simulator, wizard step 2 with repayment rules, a V2 loan in grace, a repaid V2 loan, and the offers list. No horizontal overflow and no page errors.

| Decision | Applied argument | Reason |
| --- | --- | --- |
| The signing review lists the payoff rule, term and annualized pricing (365-day year), the ceiling as a USDC amount, grace, the late fee, and a four-step timeline: Deadline, Grace ends, Priced recovery, Final claim | Plumb / Fovea | Every figure comes from `reviewFigures`, the same math the program runs; nothing is restated by hand. |
| The surplus loss is in the strong sentence before signing and in "What happens when" throughout recovery | Sol / Plumb | The final claim is an agreed default remedy that can take value beyond the debt; it is shown before signing, never discovered later. |
| The ceiling is "a limit you set in ZenLo", never a legal rate cap | Sol / Kestrel | It is a product control under the approved brief. |
| The lender's final claim needs a second click that names the surplus going to the lender | Fovea / Plumb | It is the only action that can take value beyond what is owed. |
| The rules simulator stays wallet-free on `/learn`, labelled "Simulation only", on a fixed 100 USDC, 30-day, 5% example | Sol / Hollis | Practice without the chain, kept separate from Devnet. |
| V2 rows reuse the V1 offer row. Pro-rata rows read "Less if repaid early" and the term shows "+ grace" | Indigo / Ravi | One list, one way to scan it. |
| New end states: "Settled after grace", "Recovered at the market price", "Collateral claimed". A running loan stays "Waiting for repayment" | Sol | Each path has its own word, and the existing state vocabulary is unchanged. |
| A one-line next action sits under the loan title | Ravi / Fovea | On phones the actions panel falls below the details; the next step must come first. |

**Fixed during review:**
- "take the wSOL plus 5%" became "take wSOL worth that plus 5%" in four places.
- A settled loan no longer asks a signed-out visitor to connect.
- The borrower's review gained the term rate, term cost and annualized pricing.
- The simulator: the day counter, the units, the current SOL price, and "(passed)" announced to screen readers.
- The late-fee readout no longer wraps at 390 px.
- "Running" became "Waiting for repayment".
- Percentages now have thousands separators.
