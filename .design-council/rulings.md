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
