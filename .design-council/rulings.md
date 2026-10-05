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
