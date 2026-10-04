# Design and experience

The interface is **Tenor**. It lives in `app/` and follows this file. If a screen and an instruction ever disagree, the program rules in [architecture.md](architecture.md) win. [PRODUCT.md](../PRODUCT.md) holds the audience, the personality and the anti-references.

## Feel

A private lending desk. It should feel assured, warm and precise, never like an exchange. Each screen has one primary action, the figures line up, and every input answers back while you type. Small interactions carry the personality. Risk is shown calmly, next to the number it qualifies.

Light mode only, even when the operating system is dark. Components use semantic tokens only. Hex values appear in exactly one place, the token block at the top of `app/app/globals.css`.

## Palette

The Astryx semantic token names stay as they are and point at the Tenor palette, so any component written against Astryx still works.

| Role | Token | Value |
| --- | --- | --- |
| Page | `--color-background-body` | ivory `#f6f2ea` |
| Cards and sheets | `--color-background-surface` | `#fffdf8` |
| Second neutral layer (chips, wells) | `--color-background-muted` | `#efeadf` |
| Primary text | `--color-text-primary` | ink `#14201b`, 15:1 |
| Secondary text | `--color-text-secondary` | `#4b5751`, 6.8:1 |
| Tertiary text and placeholders | `--color-text-tertiary` | `#5f6963`, at least 4.5:1 |
| Primary button, links, current selection | `--color-accent` / `--color-on-accent` | deep green `#0f4d3a` on ivory |
| The committed surface (preview panel, hero figure, toasts) | `--color-panel` | `#0d3328` |
| Brand detail: logo arc, focus ring, progress, the "watch" state | `--color-brass` | `#c9a45c`, decoration only on ivory |
| Brass as text | `--color-text-yellow` | `#7e5e22`, 5.4:1 |
| Healthy, money received | `--color-text-green` on `--color-background-green` | `#276f50` |
| Risk, failed transaction | `--color-text-red` on `--color-background-red` | `#b4432f` |
| Hairline | `--color-border` | `#e3dccd` |

Brass is the warning color. A loan near the line turns brass before it turns red, and red means something has really happened. Every state also carries a word ("Healthy", "Near the line", "Past the line"), so color is never the only signal.

## Brand

The name is **Tenor**: a loan held for a fixed term. The mark (`components/brand/LogoMark.tsx`) is a deep-green ring with a brass arc across the top and an ink stem. Together they read as a T inside a term. The arc length is live, and the same mark is reused in four places:

- the pending-transaction spinner (the arc turns);
- the progress of the create wizard (the arc grows by a quarter per step);
- the empty states (a short arc);
- the favicon (`app/icon.svg`).

## Type

- **Words:** Figtree, one family at 400 to 700. Headings use -0.02 to -0.035em tracking and balanced wrapping.
- **Figures:** IBM Plex Mono with tabular numbers, via the `.num` class, so `100.00` and `1,001.001002` share a width and a baseline.

## Motion

Uses `motion/react` with `LazyMotion` and `MotionConfig reducedMotion="user"`. Hover and press states stay in CSS. Motion only conveys a change of state:

- **Figures** count up or down to their new value with an ease-out curve and no overshoot. Money never bounces. The final frame is always the exact value.
- **Wizard steps** slide 16px in the direction of travel and fade, in about 240ms.
- **The status title** rises into place when the loan's state changes.
- **The health bar and the price ladder** glide to their new positions.
- **Chips** slide the selection pill between options.
- **Errors** shake by at most 4px, once.
- **A new offer** sends a single brass ripple across the preview panel.

With reduced motion, all of these become instant, and the spinner pulses instead of turning.

## Information architecture

- **Offers** (`/`): a three-step explainer, status filters, and a quiet list of rows.
- **Create** (`/create?step=1..4`): a four-step wizard with a live preview.
- **Offer** (`/offers/[lender]/[id]`): one loan, from creation through settlement. The title is the loan's state.
- **Connect**: a dialog listing browser wallets (Wallet Standard) and the three demo wallets.
- **Demo desk**: a side drawer, local only. It sets who you act as, the SOL price and the chain clock, and can reset the demo.

Offers are read directly from the chain. A closed offer disappears from the list, and its page says it was closed.

## Who you are

The connected address decides your role on an offer: lender, borrower or visitor. There is no role menu on the offer page. Locally, the demo desk switches between three funded keypairs. A browser wallet replaces them when it connects. A wallet signs, and Tenor sends the transaction through its own connection, so Phantom works against localnet whatever network it displays.

## Shared states

- **Empty:** the logo mark with a short arc, one sentence, and a "Create offer" text link. When the validator is unreachable, the sentence says so.
- **Loading:** skeleton bars the same size as the figures they replace. No spinner on a blank page.
- **Success:** the title changes, a green line under it says what moved ("You received 100.00 USDC"), and a toast repeats it.
- **Error:** one plain sentence in red under the button, mapped from the program's error code in `lib/anchor-errors.ts`. No stack traces. A stale price reads: "The SOL price is too old. Wait for a fresh price and try again."

## Lender: the create wizard

One question per step, with the borrower's-view preview always beside it (below it on a phone). Enter continues. Back keeps what you typed. A step only unlocks once the steps before it are valid, and the draft survives a refresh for the rest of the session.

1. **Amount.** "How much USDC will you lend?" One large amount input, quick amounts, Half and Max from your balance, and one sentence on where the USDC goes.
2. **Rate and term.** An interest slider (0 to 20% in 0.25% steps, with 5/8/12/20 markers) and term chips (10 minutes, 1, 7, 30 or 90 days, or Custom). A brass note shows the interest in USDC, and roughly what that is per year.
3. **Collateral.** One track with two handles: max LTV (at most 70%) and liquidation LTV (at most 85%). The handles cannot come within 5 points of each other.
   - wSOL is the exact minimum at the live price, plus a cushion of +10% (the default), +25% or +50%, or your own amount.
   - A price ladder shows SOL now, the price below which no borrower could accept, and the liquidation price with the percentage fall it needs.
4. **Review.** The terms as one sentence, then "If they miss that time, you receive the wSOL.", then an editable terms table. The primary is **Lock USDC**. It becomes "Connect to lock USDC" when no wallet is connected.

On success the step area becomes "Your offer is live". It says what moved and offers **View offer**, plus "Create another" as a text button.

While the offer is open, the lender's primary on the offer page is **Cancel offer**. It confirms inline: "Return the USDC to your wallet?"

Once the loan has settled, the lender gets a text button, "Close and reclaim rent". This calls `close_offer`. The account was the on-chain receipt until then.

## Borrower

The offer page leads with three figures: USDC you receive, USDC you repay, wSOL you lock. After accepting, they switch to the past tense. Then come:
- the deadline in absolute local time, with the exact sentence "If you do not repay by then, the lender receives your wSOL.";
- the health meter at today's price.

The primary is **Lock wSOL and borrow**. It is disabled, with the reason beside it, while the price is stale, the LTV check would fail, or the wallet is short of wSOL.

After accepting, the term ring counts down and the primary is **Repay**. Repay confirms inline, showing what you pay and what you receive. Once the deadline passes, the button is gone and the page says the lender can now claim the collateral.

## Liquidation

When a loan is filled, past its line and not yet expired, anyone except the borrower sees "This loan can be liquidated". The section shows three figures: USDC you pay the lender, wSOL you receive, and wSOL returned to the borrower. These match the program to the lamport. The button is **Pay the lender and take collateral**. If the loan is healthy or the price is stale, the section is not shown at all; there is no disabled button.

The lender cannot be the caller. Their USDC account would be both payer and payee, and Anchor rejects a duplicate mutable account. So the lender instead sees "Past the liquidation line: any liquidator can settle this loan now. When they do, you receive 105.00 USDC in full."

The health meter always states the SOL price at which this loan becomes liquidatable.

After the deadline, **Claim collateral** is the primary for anyone except the borrower.

## Layout

- The content column is at most 1040px. The offer and create pages put the main column beside a sticky 360px panel from 960px wide, and stack below that.
- Cards round to at most 16px. Use a single hairline or a low shadow, never both as decoration.
- The phone layout has a 16px gutter and no horizontal scroll (checked at 390px).
- Layers come from one scale: sticky, popover, backdrop, drawer, toast.

## Copy deck

Use these words, and do not rename the actions per screen.

- Lock USDC
- Cancel offer
- Lock wSOL and borrow
- Repay
- Claim collateral
- Pay the lender and take collateral

Statuses the title may use: Open offer, Waiting for repayment, Repaid, Expired, Liquidated, Cancelled.
