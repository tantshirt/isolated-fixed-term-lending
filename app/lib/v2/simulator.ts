/**
 * Wallet-free V2 simulator (Story 21.1: "Simulation and Learn use the same V2 math"). Pure state
 * over loan-math-v2, so every figure matches what isolated_loan_v2 computes. Nothing here touches
 * a wallet, a connection or the chain.
 */
import { collateralValueUsdc } from "../loan-math";
import {
  applyPayment,
  graceEnd,
  liquidationSplit,
  maturity,
  openLedger,
  payoff,
  phase,
  pricedRecoverySplit,
  terminalClaimFrom,
  type Ledger,
  type Phase,
  type TermsV2,
} from "../loan-math-v2";

export type SimV2 = {
  terms: TermsV2;
  ledger: Ledger;
  now: number;
  collateral: bigint;
  /** SOL/USD at exponent -8, with a 0.1% confidence. */
  price: bigint;
  status: "active" | "repaid" | "overdue-liquidated" | "priced-recovered" | "terminal-claimed";
  log: string[];
  /** Collateral label in the log, e.g. "wSOL" or "jitoSOL (test)" (Story 26.2). */
  unit: string;
};

const usd = (atoms: bigint) => (Number(atoms) / 1e6).toFixed(2);
const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(4);
const value = (s: SimV2) => collateralValueUsdc(s.collateral, s.price, s.price / 1000n, -8);

export function startSim(terms: TermsV2, collateral: bigint, price = 15_000_000_000n, unit = "wSOL"): SimV2 {
  return { terms, ledger: openLedger(terms), now: terms.startTs, collateral, price, status: "active", unit, log: [`Loan starts: ${usd(terms.principal)} USDC out, ${sol(collateral)} ${unit} locked.`] };
}

export function simPhase(s: SimV2): Phase {
  return phase(s.terms, s.now);
}

export function simPayoff(s: SimV2): bigint {
  return s.status === "active" ? payoff(s.terms, s.ledger, s.now) : 0n;
}

export function advance(s: SimV2, seconds: number): SimV2 {
  return { ...s, now: s.now + Math.max(0, Math.floor(seconds)) };
}

export function setPrice(s: SimV2, price: bigint): SimV2 {
  return price > 0n ? { ...s, price } : s;
}

export function pay(s: SimV2, amount: bigint): SimV2 {
  if (s.status !== "active" || amount <= 0n) return s;
  const [ledger, p] = applyPayment(s.terms, s.ledger, s.now, amount);
  const line = p.closed
    ? `Repaid ${usd(p.used)} USDC and closed the loan. All ${sol(s.collateral)} ${s.unit} returns to the borrower.`
    : `Paid ${usd(p.used)} USDC: ${usd(p.interest)} interest, ${usd(p.lateFee)} late fee, ${usd(p.principal)} principal. The deadline does not move.`;
  return { ...s, ledger, status: p.closed ? "repaid" : "active", log: [...s.log, line] };
}

export function topUp(s: SimV2, lamports: bigint): SimV2 {
  if (s.status !== "active" || lamports <= 0n) return s;
  return { ...s, collateral: s.collateral + lamports, log: [...s.log, `Added ${sol(lamports)} ${s.unit}. No price was needed.`] };
}

/** The settlement available to someone other than the borrower right now, if any. */
export function settlementNow(s: SimV2): "overdue-liquidation" | "priced-recovery" | "terminal-claim" | null {
  if (s.status !== "active") return null;
  const p = simPhase(s);
  if (p === "Terminal") return "terminal-claim";
  if (p === "PricedRecovery") return "priced-recovery";
  if (p === "Overdue") return "overdue-liquidation";
  return null;
}

export function settle(s: SimV2, kind: "overdue-liquidation" | "priced-recovery" | "terminal-claim"): SimV2 {
  if (settlementNow(s) === null) return s;
  const owed = simPayoff(s);
  if (kind === "terminal-claim" && s.now >= terminalClaimFrom(s.terms))
    return { ...s, status: "terminal-claimed", log: [...s.log, `Final claim: the lender takes all ${sol(s.collateral)} ${s.unit}, worth ${usd(value(s))} USDC against ${usd(owed)} owed.`] };
  if (kind === "priced-recovery" && s.now >= graceEnd(s.terms) + 86_400) {
    const v = value(s);
    const split = pricedRecoverySplit(owed, s.collateral, v);
    return {
      ...s,
      status: "priced-recovered",
      log: [...s.log, `Priced recovery: the lender takes ${sol(split.toRecipient)} ${s.unit}, ${sol(split.toBorrower)} ${s.unit} returns to the borrower${split.shortfall ? `, ${usd(split.shortfall)} USDC was not covered` : ""}.`],
    };
  }
  if (kind === "overdue-liquidation" && s.now >= graceEnd(s.terms)) {
    const split = liquidationSplit(owed, s.collateral, value(s));
    return { ...s, status: "overdue-liquidated", log: [...s.log, `After grace a liquidator pays ${usd(owed)} USDC, takes ${sol(split.toRecipient)} ${s.unit}, and ${sol(split.toBorrower)} ${s.unit} returns to the borrower.`] };
  }
  return s;
}

export const simDeadlines = (s: SimV2) => ({ maturity: maturity(s.terms), graceEnd: graceEnd(s.terms), pricedFrom: graceEnd(s.terms) + 86_400, terminalFrom: terminalClaimFrom(s.terms) });
