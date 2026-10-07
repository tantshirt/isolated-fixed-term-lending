import { payoff, phase } from "../loan-math-v2";
import type { OfferV2 } from "./offers";

/**
 * Refinance and rollover (Story 26.1, research.md § Refinance and rollover). Off until the
 * deployment's `isolated_loan_v2` carries `refinance_into` (Squads upgrade and time lock).
 */
export const REFINANCE_ENABLED = process.env.NEXT_PUBLIC_REFINANCE_ENABLED === "1";

/** Seconds of accrual a signature allows for while it is reviewed and confirmed. */
export const REFINANCE_SIGNING_ALLOWANCE = 120;

export type RefinanceQuote = {
  /** What the old lender receives: the old loan's payoff at `now`. */
  payoffOld: bigint;
  /** Paid by the new lender straight to the old lender. */
  newPrincipal: bigint;
  /** Paid by the borrower: `payoffOld - newPrincipal`, never negative. */
  contribution: bigint;
  /** Collateral the new loan locks (the new offer's requirement). */
  newCollateral: bigint;
  /** Positive: wSOL that returns to the borrower. Negative: wSOL the borrower adds. */
  collateralBack: bigint;
  /** Why this offer cannot take the loan, or null when it can. */
  reason: string | null;
};

/** The old loan may refinance only in its Active or Grace phase. */
export function canRefinance(old: OfferV2, now: number): boolean {
  if (old.status !== "active") return false;
  const p = phase(old.terms, now);
  return p === "Active" || p === "Grace";
}

/**
 * The figures the borrower signs for, using the same payoff the program computes. A new principal
 * above the payoff is a cash-out and is never allowed.
 */
export function refinanceQuote(old: OfferV2, next: OfferV2, borrower: string, now: number): RefinanceQuote {
  const payoffOld = old.status === "active" ? payoff(old.terms, old.ledger, now) : 0n;
  const newPrincipal = next.terms.principal;
  const contribution = payoffOld > newPrincipal ? payoffOld - newPrincipal : 0n;
  const quote = { payoffOld, newPrincipal, contribution, newCollateral: next.collateralRequired, collateralBack: old.collateralLocked - next.collateralRequired };
  const reason = !canRefinance(old, now)
    ? "Only a loan before the end of grace can refinance."
    : next.status !== "open"
      ? "That offer is no longer open."
      : next.publicKey === old.publicKey
        ? "A loan cannot refinance into itself."
        : next.usdcMint !== old.usdcMint || next.wsolMint !== old.wsolMint
          ? "The new offer lends a different asset or takes different collateral."
          : next.restrictedBorrower !== null && next.restrictedBorrower !== borrower
            ? "This renewal offer is reserved for another borrower."
            : next.originLender === borrower || next.currentLender === borrower
              ? "You cannot borrow from your own offer."
              : newPrincipal > payoffOld
                ? "The new principal is above what you owe. Refinancing never pays cash out."
                : null;
  return { ...quote, reason };
}

/** Open offers the borrower could move this loan into, cheapest contribution first. */
export function refinanceCandidates(old: OfferV2, offers: OfferV2[], borrower: string, now: number): { offer: OfferV2; quote: RefinanceQuote }[] {
  return offers
    .filter((o) => o.status === "open" && o.publicKey !== old.publicKey)
    .map((offer) => ({ offer, quote: refinanceQuote(old, offer, borrower, now) }))
    .filter((c) => c.quote.reason === null)
    .sort((a, b) => (a.quote.contribution < b.quote.contribution ? -1 : a.quote.contribution > b.quote.contribution ? 1 : 0));
}
