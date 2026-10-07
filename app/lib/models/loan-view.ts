import { canLiquidate, computeHealth, debtOf, type PriceSnapshot } from "../offer-status";
import type { Offer } from "../offers";
import { loanActionAllowed, type LoanAction, type OpsFlag } from "../ops-flags";
import type { ProgramGeneration } from "./index";
import { collateralValueUsdc, currentLtvBps, healthBps } from "../loan-math";
import { graceEnd, liquidationTrigger, maturity, payoff as payoffV2, phase as phaseV2, pricedRecoveryFrom, terminalClaimFrom, type LiquidationKind, type Phase } from "../loan-math-v2";
import type { OfferV2 } from "../v2/offers";

export type Deadline = { kind: "maturity" | "grace-end" | "priced-recovery" | "terminal-claim"; at: number };

export type ViewAction = { action: LoanAction; by: "lender" | "borrower" | "anyone"; available: boolean; reason?: string };

/**
 * The one loan shape every screen reads (Story 19.4). Screens show these figures and actions
 * instead of recomputing them, so the public, private, legacy and V2 paths cannot drift apart.
 */
export type LoanView = {
  generation: ProgramGeneration;
  key: string;
  status: Offer["status"] | OfferV2["status"];
  /** V2 only: where the loan is in its timeline. */
  phase?: Phase;
  lender: string;
  borrower: string | null;
  principal: bigint;
  remainingPrincipal: bigint;
  /** What the borrower must pay now to close the loan. */
  payoff: bigint;
  risk: { ltvBps: number; healthBps: number; liquidatable: boolean; priced: boolean; emaLtvBps?: number | null; trigger?: LiquidationKind | null } | null;
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

/**
 * V2 loans: payoff from the shared accounting, the four post-deadline windows, and the same
 * spot-plus-EMA trigger the program uses. Repayment stays available until a settlement executes.
 */
export function v2LoanView(o: OfferV2, price: PriceSnapshot | null, chainNow: number, flags: OpsFlag[] = []): LoanView {
  const active = o.status === "active";
  const phase = active ? phaseV2(o.terms, chainNow) : undefined;
  const owed = active ? payoffV2(o.terms, o.ledger, chainNow) : 0n;
  const priced = !!price?.fresh;

  let risk: LoanView["risk"] = null;
  if (active && price) {
    const value = collateralValueUsdc(o.collateralLocked, price.price, price.conf, price.exponent);
    const ltv = currentLtvBps(owed, value);
    const emaLtv = price.ema && price.ema.price > price.ema.conf && price.ema.conf * 10_000n <= price.ema.price * 200n
      ? currentLtvBps(owed, collateralValueUsdc(o.collateralLocked, price.ema.price, price.ema.conf, price.exponent))
      : null;
    const trigger = priced ? liquidationTrigger(ltv, emaLtv, o.liquidationLtvBps) : null;
    risk = { ltvBps: ltv, healthBps: healthBps(ltv, o.liquidationLtvBps), liquidatable: !!trigger && (phase === "Active" || phase === "Grace"), priced, emaLtvBps: emaLtv, trigger };
  }

  const gate = (action: LoanAction, by: ViewAction["by"], ok: boolean, reason?: string): ViewAction => {
    const flag = loanActionAllowed(action, flags);
    if (!flag.allowed) return { action, by, available: false, reason: flag.reason };
    return ok ? { action, by, available: true } : { action, by, available: false, reason };
  };
  const at = (t: number) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const actions: ViewAction[] = [];
  if (o.status === "open") {
    actions.push(gate("accept", "borrower", true));
    actions.push(gate("cancel", "lender", true));
  }
  if (active && phase) {
    const t = o.terms;
    const needPrice = "A fresh price is needed. Post one, then try again.";
    actions.push(gate("repay", "borrower", true));
    actions.push(gate("add-collateral", "borrower", true));
    actions.push(
      gate(
        "liquidate",
        "anyone",
        !!risk?.liquidatable,
        phase !== "Active" && phase !== "Grace" ? "After grace, use the overdue settlement instead." : !priced ? needPrice : "The loan is not past its liquidation line on both the live and average price.",
      ),
    );
    actions.push(gate("liquidate-overdue", "anyone", chainNow >= graceEnd(t) && priced, chainNow < graceEnd(t) ? `Opens when grace ends, ${at(graceEnd(t))}.` : needPrice));
    actions.push(gate("claim-priced", "lender", chainNow >= pricedRecoveryFrom(t) && priced, chainNow < pricedRecoveryFrom(t) ? `Opens ${at(pricedRecoveryFrom(t))}.` : needPrice));
    actions.push(gate("claim-terminal", "lender", chainNow >= terminalClaimFrom(t), `Opens ${at(terminalClaimFrom(t))}.`));
  }
  if (!["open", "active"].includes(o.status)) actions.push(gate("close", "lender", true));

  const t = o.terms;
  return {
    generation: "v2",
    key: o.publicKey,
    status: o.status,
    phase,
    lender: o.currentLender,
    borrower: o.borrower,
    principal: t.principal,
    remainingPrincipal: active ? o.ledger.outstandingPrincipal : 0n,
    payoff: owed,
    risk,
    deadlines:
      active || o.status === "open"
        ? [
            { kind: "maturity", at: maturity(t) },
            { kind: "grace-end", at: graceEnd(t) },
            { kind: "priced-recovery", at: pricedRecoveryFrom(t) },
            { kind: "terminal-claim", at: terminalClaimFrom(t) },
          ]
        : [],
    actions,
  };
}
