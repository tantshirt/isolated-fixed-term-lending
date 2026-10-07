import { canLiquidate, computeHealth, debtOf, type PriceSnapshot } from "../offer-status";
import type { Offer } from "../offers";
import { loanActionAllowed, type LoanAction, type OpsFlag } from "../ops-flags";
import type { ProgramGeneration } from "./index";

export type Deadline = { kind: "maturity" | "grace-end" | "priced-recovery" | "terminal-claim"; at: number };

export type ViewAction = { action: LoanAction; by: "lender" | "borrower" | "anyone"; available: boolean; reason?: string };

/**
 * The one loan shape every screen reads (Story 19.4). Screens show these figures and actions
 * instead of recomputing them, so the public, private, legacy and V2 paths cannot drift apart.
 */
export type LoanView = {
  generation: ProgramGeneration;
  key: string;
  status: Offer["status"];
  lender: string;
  borrower: string | null;
  principal: bigint;
  remainingPrincipal: bigint;
  /** What the borrower must pay now to close the loan. */
  payoff: bigint;
  risk: { ltvBps: number; healthBps: number; liquidatable: boolean; priced: boolean } | null;
  deadlines: Deadline[];
  actions: ViewAction[];
};

/** Legacy loans: full-term interest, no grace, and the lender may claim everything at expiry. */
export function legacyLoanView(offer: Offer, price: PriceSnapshot | null, chainNow: number, flags: OpsFlag[] = []): LoanView {
  const owed = debtOf(offer);
  const active = offer.status === "filled";
  const expired = active && chainNow >= offer.expiryTs;
  const risk = active && price ? (() => {
    const h = computeHealth(offer, price);
    return { ltvBps: h.currentLtvBps, healthBps: h.healthBps, liquidatable: canLiquidate(offer, price, chainNow), priced: price.fresh };
  })() : null;

  const gate = (action: LoanAction, by: ViewAction["by"], ok: boolean, reason?: string): ViewAction => {
    const flag = loanActionAllowed(action, flags);
    if (!flag.allowed) return { action, by, available: false, reason: flag.reason };
    return ok ? { action, by, available: true } : { action, by, available: false, reason };
  };

  const actions: ViewAction[] = [];
  if (offer.status === "open") {
    actions.push(gate("accept", "borrower", true));
    actions.push(gate("cancel", "lender", true));
  }
  if (active) {
    actions.push(gate("repay", "borrower", !expired, "The deadline has passed, so repayment is closed."));
    actions.push(gate("claim", "anyone", expired, "Claiming opens at the deadline."));
    actions.push(gate("liquidate", "anyone", !!risk?.liquidatable, risk ? "The loan is not past its liquidation line." : "A fresh price is needed."));
  }
  if (["repaid", "expired", "liquidated", "cancelled"].includes(offer.status)) actions.push(gate("close", "lender", true));

  return {
    generation: "legacy",
    key: offer.publicKey,
    status: offer.status,
    lender: offer.lender,
    borrower: offer.borrower,
    principal: offer.principal,
    remainingPrincipal: active ? offer.principal : 0n,
    payoff: active ? owed : 0n,
    risk,
    deadlines: active ? [{ kind: "maturity", at: offer.expiryTs }, { kind: "terminal-claim", at: offer.expiryTs }] : [],
    actions,
  };
}
