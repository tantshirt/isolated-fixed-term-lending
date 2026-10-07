/**
 * Private activity rows (Story 26.8). Built only in the browser from rollup reads the wallet has
 * already made with its own TEE token (the decoded private V2 loan terms). Nothing here talks to a
 * server: this module imports only the pure CSV module, and a test enforces that no app API route,
 * Convex client or `fetch` is reachable from it. Private rows never pass through ZenLo's servers,
 * Convex, telemetry or notifications.
 *
 * The rollup keeps a ledger, not a per-transaction log, so private rows are the ledger's facts:
 * origination, what has been paid to date by kind, and the settlement. They carry slot 0 and a
 * synthetic `private:` signature, so they sort after nothing public and replay identically.
 */
import { atomsToDecimal, isoUtc, type ActivityRow } from "./activity";

type Key = { toBase58(): string };

/** The fields of a decoded private V2 `LoanTerms` this export reads (structurally `LoanTermsV2`). */
export type PrivateLoanSnapshot = {
  currentLender: Key;
  originLender: Key;
  borrower: Key;
  status: string;
  terms: { principal: bigint; startTs: number };
  ledger: { outstandingPrincipal: bigint; interestPaid: bigint; lateFeePaid: bigint; lastAccrualTs: number };
  shortfall: bigint;
  settledTs: number;
};

export type PrivatePosition = { anchor: Key; side: "lender" | "borrower"; terms: PrivateLoanSnapshot };

const STARTED = new Set(["active", "repaid", "liquidated", "overdueLiquidated", "pricedRecovered", "terminalClaimed", "refinanced"]);

export function privateActivityRows(positions: PrivatePosition[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const { anchor, side, terms: t } of positions) {
    if (!STARTED.has(t.status)) continue;
    const loan = anchor.toBase58();
    const row = (action: string, atoms: bigint, ts: number): ActivityRow => ({
      timeUtc: isoUtc(ts),
      slot: 0,
      signature: `private:${loan}:${action}`,
      loan,
      role: side,
      action,
      asset: "USDC",
      amountAtoms: atoms.toString(),
      amountDecimal: atomsToDecimal(atoms, 6),
      fee: "0",
      status: t.status,
    });
    // A lender who did not originate holds a bought position; the private price is not on the ledger.
    const bought = side === "lender" && t.originLender.toBase58() !== t.currentLender.toBase58();
    rows.push(bought ? row("holds-bought-position", 0n, t.terms.startTs) : row(side === "lender" ? "lend" : "borrow", t.terms.principal, t.terms.startTs));
    const asOf = t.settledTs > 0 ? t.settledTs : t.ledger.lastAccrualTs || t.terms.startTs;
    const principalRepaid = t.terms.principal - t.ledger.outstandingPrincipal;
    if (t.ledger.interestPaid > 0n) rows.push(row("interest-paid-to-date", t.ledger.interestPaid, asOf));
    if (t.ledger.lateFeePaid > 0n) rows.push(row("late-fee-paid-to-date", t.ledger.lateFeePaid, asOf));
    if (principalRepaid > 0n) rows.push(row("principal-repaid-to-date", principalRepaid, asOf));
    if (t.shortfall > 0n) rows.push(row("shortfall", t.shortfall, t.settledTs));
    if (t.settledTs > 0) rows.push(row(`settled-${t.status}`, 0n, t.settledTs));
  }
  return rows;
}
