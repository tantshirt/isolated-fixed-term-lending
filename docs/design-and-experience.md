# LegitShark design and experience

LegitShark (renamed from Lendspan on 2026-10-06, which replaced Tenor) keeps the Lendspan tokens and adds Sharky, see Name and mascot. Product intent lives in [PRODUCT.md](../PRODUCT.md); financial rules in [research.md](research.md) and [architecture.md](architecture.md) remain authoritative. The [design council](../.design-council/README.md) records project-specific decisions and upstream provenance.

## Identity and type

LegitShark's voice is direct, approachable and precise. Tagline: **Clear terms. One loan at a time.** Use Inter for headings, text, controls and financial values, with tabular numerals where values align or change. Reserve monospace for addresses or technical details. Body text starts at 16px; controls on phones do not shrink below 16px. Headings wrap naturally, with tracking no tighter than -0.04em.

Light mode only: white surfaces, cool neutral layers, blue primary actions, distinct semantic success/warning/error states. Keep Astryx semantic tokens. Palette literals belong in the token block in `app/app/globals.css`; components consume tokens. The previous ivory/green/brass palette and requirement for mono financial figures are superseded.

## Name and mascot

The product is **LegitShark**: "Yes, a loan shark. A legit one." The name gets a laugh. Then the page proves the point, because both parties see every term before anything is signed.

**Sharky** is the mascot, the good loan shark.

- **Look:** soft 3D vinyl-toy finish, a cool grey shark with a white belly.
  - **Anatomy:** flat-topped head with no fin on it, exactly one dorsal fin on his upper back, two legs, no tail.
  - **Public outfit:** short-sleeve cobalt knit polo with white piping, thin gold chain, gold watch, white pleated slacks, white loafers, small dark gold-framed sunglasses. Miami nightlife, not a business suit. Reference: `app/public/illustrations/sharky-public.webp`.
- **Face:** a closed smirk or a grin with rounded teeth. Never a snarl, blood or menace.
- **PI variant (private rooms):** navy belted trench coat, wide-brim navy fedora with a cobalt band, round wire glasses, cobalt tie, magnifying glass and sealed envelope. The noir is in his posture, not in a dark canvas. Reference: `app/public/illustrations/sharky-pi.webp`.
- **Where he appears:**
  - He appears in heroes, story steps, use cases, empty states, wizard side panels and the error page.
  - He never appears inside a figure readout, a risk warning, a signing control or a liquidation state. Story art beside explanatory copy is fine.
- **Voice:** wry and precise, one line at most, like "Terms first. Handshake second." Numbers and risk copy stay in plain product language.
- **Motion:** one entrance on the hero (at most 250 ms), then still. No idle loops.
- **Prompts:** in `docs/brand/sharky-prompts.json`, following the GPT Image prompt guide. Every pose uses the matching approved sheet (public or PI) as its only identity reference.

## Information architecture

- `/`: explanatory landing page, primary **Try the demo**, secondary **Use Devnet**.
- `/demo`: wallet-free guided simulation and free exploration.
- `/devnet`: actual offer list and wallet-based transactions.
- `/devnet/discover`: the live marketplace. **Borrowers asking** and **Lenders offering**, each with **Public** and **Private**. Public rows are on-chain requests and offers; private borrower rows are discovery cards showing only the fields their borrower chose. Private lenders have no listing, and the page says so instead of inventing one. A status badge says whether the list is live, polling, or unreachable, in words.
- `/devnet/discover/request`: borrower's choice of public or private, then the public request wizard. `/devnet/requests/[borrower]/[id]`: one public request, where a lender funds it.
- Create and offer details live under their respective experience. Existing create/offer links redirect into Devnet.

Landing and simulation do not initialize wallet providers or depend on chain availability. The Devnet shell identifies the network, displays readiness and connects a wallet only when the visitor chooses to. No registration or sign-in.

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
