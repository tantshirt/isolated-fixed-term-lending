# ZenLo design and experience

ZenLo (renamed from LegitShark on 2026-10-06, earlier Lendspan and Tenor) keeps the Astryx semantic tokens and retires the Sharky mascot. Product intent lives in [PRODUCT.md](../PRODUCT.md); financial rules in [research.md](research.md) and [architecture.md](architecture.md) remain authoritative. The [design council](../.design-council/README.md) records project-specific decisions. The approved screens are the [ZenLo design canvas](https://claude.ai/artifact/5gGPGh4BdF71k8b8vCzapD); when this file and the canvas disagree, this file wins for rules and the canvas wins for layout.

## Identity and type

ZenLo's voice is direct, calm and precise: "we're the legit, transparent lenders". Tagline: **Clear terms. Zero drama.** Nunito carries headings, text, controls and financial values, with tabular numerals where values align or change. Headings are heavy (800–900) with tracking no tighter than -0.045em. Reserve IBM Plex Mono for addresses or technical details. Body text starts at 16px; controls on phones do not shrink below 16px.

Light only: white and cool-blue surfaces, navy ink (`#0f1f4b`), blue primary actions (`#245be8`), cloud (`#eaf0ff`) and sky (`#a9c4ff`) tints, distinct semantic success/warning/error states. Navy panels mark private features, so private always looks different from public without a dark canvas. Buttons are pills; cards are rounded (24px containers, 14px elements). Palette literals belong in the token block in `app/app/globals.css`; components consume tokens.

## Name and mark

The product is **ZenLo**, spelled with a capital Z and a capital L. The name promises calm; the page proves it, because both parties see every term before anything is signed.

- **Mark:** a pebble crossed by a wave on a blue rounded tile (`docs/brand/zenlo/mark.svg`, component `components/brand/Mark.tsx`). It doubles as the favicon and reads at 16px. `LogoMark` stays the progress ring used for transaction state.
- **No mascot.** Art is abstract: soft matte clay pebbles and shapes, two-tone blue, resting on still white-blue water with clean concentric ripples. The hero is a balanced stack of three pebbles.
- **Where art appears:** heroes, story chapters, use cases, the private chapter, empty and error states, and the request venue choice. Never inside a figure readout, a risk warning, a signing control or a liquidation state.
- **Prompts:** in `docs/brand/zenlo-prompts.json`, generated with `app/scripts/generate-art.mjs` using the approved stack image as the only style reference. Receipts are in `docs/brand/generation-receipts.json`.
- **Motion:** one entrance on the hero (at most 250 ms), then still. No idle loops.

## Returning users

There is no account sign-up. A remembered wallet is the identity: it reconnects on reload, and `/devnet/me` (My loans) is the home for a returning lender or borrower, ordered by what needs attention first.

## Information architecture

- `/`: explanatory landing page, primary **Try the demo**, secondary **Use Devnet**.
- `/demo`: wallet-free guided simulation and free exploration.
- `/devnet`: actual offer list and wallet-based transactions.
- `/devnet/discover`: the live marketplace. **Borrowers asking** and **Lenders offering**, each with **Public** and **Private**. Public rows are on-chain requests and offers; private borrower rows are discovery cards showing only the fields their borrower chose. Private lenders have no listing, and the page says so instead of inventing one. A status badge says whether the list is live, polling, or unreachable, in words.
- `/devnet/discover/request`: borrower's choice of public or private, then the public request wizard. `/devnet/requests/[borrower]/[id]`: one public request, where a lender funds it.
- Create and offer details live under their respective experience. Existing create/offer links redirect into Devnet.

Landing and simulation do not initialize wallet providers or depend on chain availability. The Devnet shell identifies the network, displays readiness and connects a wallet only when the visitor chooses to, then remembers that choice. No registration.

## Landing story

Explain what the loan does, what the lender and borrower supply, how terms are fixed, and what happens at settlement. Use actual product components or a clear fund-flow diagram. Scroll motion follows the story and enhances already-visible content; never hijack scrolling. Include repayment, price-drop risk and expiry, a concise FAQ, and another invitation to try the demo. No invented traction, testimonials or financial guarantees.

## Guided journey

**Set terms → Borrow → Manage → Settle.** Follow one loan across clearly named perspectives, preserving the same figures. Start with editable example terms. Keep an exit to free exploration available. Simulation roles are explicit; Devnet authority comes exclusively from the connected wallet.

### Lender wizard

Four named steps: **Amount, Rate and term, Collateral, Review**. Back and refresh preserve valid drafts. Invalid deep links return to the earliest unmet step. Each step shows inline feedback and a live summary of what each side gives and receives. Review allows editing earlier choices.

Collateral begins with understandable choices and a visible collateral amount. Advanced LTV controls and exact calculations remain accessible through detail disclosure. Always explain that interest applies to the whole term, even if the borrower repays early.

### Borrower request wizard

The lender wizard's four steps, written from the borrower's side: **You borrow**, **You pay**, **wSOL you lock**. The live summary shows the **Lender's view**. Step zero chooses public or private; private continues in a room. Wrapping SOL is its own explicit button when the wallet holds too little wSOL, never a silent step inside posting.

Funding a request reads the price at funding. When the Devnet price is older than 60 seconds, say before the click that funding first posts a fresh price and asks for extra signatures.

### Borrower and active loan

Before accepting, show USDC received, total USDC repayment, required wSOL, duration and estimated deadline, and liquidation consequences. Explain that wSOL is wrapped SOL. The actual deadline starts on acceptance; after confirmation show its absolute time and remaining time.

The exact expiry sentence is: **If you do not repay by then, the lender receives your wSOL.**

Offer repayment with an inline review of what is paid and returned. At the first expired second, repayment is no longer available. Keep price age and loan status truthful when the network is unavailable.

### Settlement and replay

After each action, say what moved and what can happen next. Devnet receipts link confirmed transactions to the Devnet explorer. Simulation receipts identify themselves as simulated and offer reset/replay through repayment, liquidation and expiry. A reset never changes any Devnet state.

Liquidation uses exact existing integer calculations and real eligibility rules. The simulation can change its sample market; Devnet cannot change the market or skip time. Live liquidation is conditional on genuine price eligibility. Lender self-liquidation remains unavailable under the current program's duplicate-account constraint.

## Transaction and network feedback

Distinguish checking, waiting for a wallet, submitting, confirming, confirmed, rejected, failed and uncertain outcomes. Preserve an uncertain signature and reconcile it before another submission. A disconnected RPC is not an empty balance or a closed offer. Display actionable reasons for disabled actions. Clear old wallet-specific success messages when the signer changes.

Guide Devnet users to test SOL and canonical test USDC, and provide explicit wrapping when needed. Oracle refresh may require additional signatures; say so before starting. Local validator controls are development-only and unavailable in public deployments.

## Motion and accessibility

Use the existing Motion library for short state transitions, not decorative loops. Typical product transitions are 150–250ms without financial overshoot. Native scrolling remains intact. Reduced motion retains every state and explanation with instant or gentle transitions. Keyboard navigation, meaningful step focus, announcements, readable contrast and status words are required.

Desktop layouts pair the decision area with a stable summary; phones stack them without losing the figures needed to make the decision. Validate 390px, tablet and 1440px layouts, including long addresses and fractional token amounts.

## Action vocabulary

Keep actions understandable and consistent: **Lock USDC**, **Cancel offer**, **Lock wSOL and borrow**, **Repay**, **Claim collateral**, **Pay the lender and take collateral**, and **Close and reclaim rent**. Requests add **Lock wSOL and post request**, **Fund this request**, **Cancel request**, and **Close request**. Simulation may use explanatory introductions but must preserve each action's actual consequence.

States remain **Open offer**, **Waiting for repayment**, **Repaid**, **Expired**, **Liquidated**, **Cancelled**, with a separate closed-account result. A transaction submission alone does not establish a new loan state.
