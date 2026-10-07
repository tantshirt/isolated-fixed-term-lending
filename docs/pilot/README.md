# Lender pilot

Stage 0 of the desk-first roadmap. Recruit five to ten real lender operators while development runs, watch how they work today, and bring them onto ZenLo desks as each flow becomes usable. The customer gate (Story 25.1) is measured from this pilot.

| File | Use it for |
| --- | --- |
| [interview-script.md](interview-script.md) | The first 45-minute call with a prospective operator |
| [onboarding.md](onboarding.md) | Bringing an operator onto Devnet and their first desk |
| [observation-checklist.md](observation-checklist.md) | What to record while watching a session, without helping |
| [comprehension-check.md](comprehension-check.md) | The five questions every participant must answer before the gate counts them |

Rules:

- Devnet only, with test assets. Say so at the start of every session. No real funds, no real cash.
- Do not sign, click or type for a participant after onboarding. If you have to, log the loan as **assisted**. Assisted loans count against the 80% unassisted share.
- Any wallet the developer controls goes into [`app/lib/pilot/developer-wallets.json`](../../app/lib/pilot/developer-wallets.json) before it is used. Activity involving those wallets never counts. `app/lib/pilot/gate.ts` reads the list.
- Do not collect personal documents, income evidence or legal identity. The pilot is about workflow, not underwriting.
- Notes go into the pilot log with the participant's chosen alias, never their wallet address next to their real name.
