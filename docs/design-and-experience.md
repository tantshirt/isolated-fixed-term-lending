# Design and experience

Week 1 does not build these screens. Week 2 does, and it follows this file. The program rules in [architecture.md](architecture.md) win if a screen and an instruction ever disagree.

## Feel

A calm lending desk. Light, quiet, and a little spacious. One primary action on each screen. Money figures line up. Nothing blinks, and nothing looks like a trading terminal.

Use the Astryx Neutral theme and stay in light mode even if the operating system is dark. Do not invent a parallel palette. Cite the tokens below. Semantic tokens only; do not hardcode a hex in the app.

| Role | Token |
| --- | --- |
| Page background | `--color-background-body` |
| Cards and sheets | `--color-background-surface` |
| Primary text | `--color-text-primary` |
| Secondary text | `--color-text-secondary` |
| Disabled | `--color-text-disabled` |
| The one primary button, and focus | `--color-accent`, `--color-on-accent`, `--focus-outline-color` |
| Hairline | `--color-border` |
| Money received, loan healthy | `--color-text-green` on `--color-background-green` |
| Risk, unhealthy, failed transaction | `--color-text-red` on `--color-background-red` |
| Approaching the line, not yet liquidatable | `--color-text-yellow` on `--color-background-yellow` |
| Loading | `--color-skeleton` |
| Card radius | `--radius-container` |
| Control radius | `--radius-element` |
| Card elevation | `--shadow-low` |
| Page padding | `--spacing-12` on large screens, `--spacing-6` on a phone |
| Space inside a card | `--spacing-6` |
| Gap between sections | `--spacing-8` |
| Control height | `--size-element-lg` for the primary button, `--size-element-md` for inputs |
| Words | `--font-family-heading` and `--font-family-body` (Figtree) |
| Figures | `--font-family-code`, tabular numbers, right-aligned in any column |

Page content sits in a column about 720px wide for a single loan, and about 960px for the offer list. Do not stretch a loan across a ultrawide monitor. That empty margin is intentional.

The accent stays the Neutral ink. Green is for "you receive" and for a healthy loan. Red is for a real problem. Yellow is a warning, used sparingly. Do not paint the whole page green because it is a finance app.

Motion stays inside `--duration-fast` and `--ease-standard`. A status change fades. It does not bounce.

## Information architecture

- Offers. The list of open offers.
- Offer. One loan, from creation through settlement.
- Create. A lender's new offer, on one page, with the summary above the button.

A person always knows which of those three they are on. The title is the loan's state in plain language: "Open offer", "Waiting for repayment", "Repaid", "Expired", "Liquidated".

## Shared states

Every screen has the same four states.

- Empty: a short sentence and one action. The offer list says "No open offers" and shows "Create offer" only as a text button, not a second competing primary if the reader is here to borrow.
- Loading: skeleton bars in `--color-skeleton`, the same size as the numbers they replace. No spinner in the middle of a blank page.
- Success: the status title changes, the balances update, and a single line says what moved. "You received 100.00 USDC" or "You received your wSOL back."
- Error: the primary button returns to rest, and one sentence from the program sits under it in `--color-text-red`. Do not show a stack trace. If the price is stale, say "The SOL price is too old. Wait for a fresh price and try again."

## Lender

Create, on one page, in this order: USDC amount, interest for the whole term, duration, wSOL required, max LTV, liquidation LTV. Under the fields, a summary in figures: what the borrower will owe, the last second they can repay, and the line "If they miss that time, you receive the wSOL." The only primary button is "Lock USDC".

While the offer is open, the offer screen's primary button is "Cancel offer". Cancelling asks once: "Return the USDC to your wallet?"

While the loan is filled, there is no primary button for the lender unless the loan is unhealthy or expired. If it is unhealthy, the primary is "Liquidate". If it is expired, the primary is "Claim collateral". The summary shows principal, debt, collateral, health, and the deadline. Health uses `health_bps` from the research note, shown as a percent with one decimal.

Settled screens have no primary button. They show the ending in one line and the amounts.

## Borrower

The offer list is a quiet table: principal, wSOL required, term, interest, max LTV. One row action, "Review", opens the offer. Rows are not cards stacked in a carnival.

The review screen leads with three figures: USDC you receive, USDC you will repay, wSOL you lock. Under them, the deadline in absolute local time, and this sentence with no softer paraphrase: "If you do not repay by then, the lender receives your wSOL." Health at the current price is shown so they can see the gap to liquidation. The only primary button is "Lock wSOL and borrow". It stays disabled until the price is fresh and the LTV check would pass.

After accept, the primary button is "Repay". The repay sheet repeats the debt and "You receive your wSOL back." If the deadline has passed, the button is gone and the screen says the collateral has gone, or is going, to the lender.

## Liquidator

Unhealthy loans are not a separate casino page. On the offer, when the loan is filled and unhealthy and not yet expired, a section titled "This loan can be liquidated" shows three figures: USDC you pay the lender, wSOL you receive, wSOL returned to the borrower. The primary button is "Pay the lender and take collateral". If the price is stale or the loan is healthy, that section is absent. Do not show a disabled liquidate button on a healthy loan. Absence is clearer than a grey button.

The lender sees the same section and may press it. The borrower never does. They see "Repay" instead, for as long as the deadline has not passed.

## What good feng shui means here

- One column of content, generous margin, cards with `--shadow-low` rather than heavy frames.
- The primary action sits at the end of the reading order, once. A second action is a text button.
- Figures share a baseline and a width so 100.00 and 1,001.001002 do not jump.
- Warnings sit next to the number they qualify, not in a banner at the top of the app.
- The expiry sentence is on the accept screen in body text, `--color-text-primary`, not muted to `--color-text-disabled`.

## Copy deck

Use these words. Do not rename the actions per screen.

- Lock USDC
- Cancel offer
- Lock wSOL and borrow
- Repay
- Claim collateral
- Pay the lender and take collateral

Statuses the title may use: Open offer, Waiting for repayment, Repaid, Expired, Liquidated, Cancelled.
