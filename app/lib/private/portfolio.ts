// Private side of My loans (Story 24.2). Pure: works on loans already read through the TEE with
// the wallet's own token, so nothing here reaches a server or Convex.
import type { PublicKey } from "@solana/web3.js";
import { debt } from "../loan-math";
import { payoff, sync } from "../loan-math-v2";
import type { LoanTermsV2 } from "./v2-codec";
import { bidState, type BidState, type MyRoom, type RoomLoan } from "./inbox";
import type { LoanTerms } from "./loan-codec";

export type PrivatePosition = {
  side: "lender" | "borrower";
  room: MyRoom;
  anchor: PublicKey;
  terms: LoanTerms;
  state: BidState;
};

export type PrivateTotals = { lentOut: bigint; owedToYou: bigint; borrowed: bigint; youOwe: bigint; waitingForYou: number };

/** Every private loan where this wallet is a party, from loans its token could read. */
export function privatePositions(wallet: PublicKey, rooms: { room: MyRoom; loans: RoomLoan[] }[]): PrivatePosition[] {
  const out: PrivatePosition[] = [];
  for (const { room, loans } of rooms)
    for (const l of loans) {
      if (!l.terms) continue;
      const side = l.terms.lender.equals(wallet) ? "lender" : l.terms.borrower.equals(wallet) ? "borrower" : null;
      if (side) out.push({ side, room, anchor: l.anchor, terms: l.terms, state: bidState(l.terms) });
    }
  return out;
}

/** Running loans only, so a private total means the same as its public twin. */
export function privateTotals(positions: PrivatePosition[]): PrivateTotals {
  const running = positions.filter((p) => p.terms.status === "active");
  const sum = (xs: PrivatePosition[], f: (p: PrivatePosition) => bigint) => xs.reduce((t, p) => t + f(p), 0n);
  const owed = (p: PrivatePosition) => debt(p.terms.principal, p.terms.interestBps);
  return {
    lentOut: sum(running.filter((p) => p.side === "lender"), (p) => p.terms.principal),
    owedToYou: sum(running.filter((p) => p.side === "lender"), owed),
    borrowed: sum(running.filter((p) => p.side === "borrower"), (p) => p.terms.principal),
    youOwe: sum(running.filter((p) => p.side === "borrower"), owed),
    waitingForYou: positions.filter((p) => p.side === "borrower" && p.terms.status === "funded").length,
  };
}

// ---- private V2 rooms (Story 24.2 with Story 22.1): same totals, V2 ledger figures.

export type PrivateV2Position = { side: "lender" | "borrower"; room: { creator: string; roomId: string }; index: number; anchor: PublicKey; terms: LoanTermsV2 };

export function privateV2Positions(wallet: PublicKey, rooms: { room: { creator: string; roomId: string }; loans: { index: number; anchor: PublicKey; terms: LoanTermsV2 | null }[] }[]): PrivateV2Position[] {
  const out: PrivateV2Position[] = [];
  for (const { room, loans } of rooms)
    for (const l of loans) {
      if (!l.terms) continue;
      const side = l.terms.currentLender.equals(wallet) ? "lender" : l.terms.borrower.equals(wallet) ? "borrower" : null;
      if (side) out.push({ side, room, index: l.index, anchor: l.anchor, terms: l.terms });
    }
  return out;
}

/** Running loans only: principal still outstanding, and the payoff today from the V2 ledger. */
export function privateV2Totals(positions: PrivateV2Position[], now: number): PrivateTotals {
  const running = positions.filter((p) => p.terms.status === "active");
  const owed = (p: PrivateV2Position) => payoff(p.terms.terms, sync(p.terms.terms, p.terms.ledger, now), now);
  const sum = (xs: PrivateV2Position[], f: (p: PrivateV2Position) => bigint) => xs.reduce((t, p) => t + f(p), 0n);
  const lend = running.filter((p) => p.side === "lender");
  const borrow = running.filter((p) => p.side === "borrower");
  return {
    lentOut: sum(lend, (p) => p.terms.ledger.outstandingPrincipal),
    owedToYou: sum(lend, owed),
    borrowed: sum(borrow, (p) => p.terms.ledger.outstandingPrincipal),
    youOwe: sum(borrow, owed),
    waitingForYou: positions.filter((p) => p.side === "borrower" && p.terms.status === "funded").length,
  };
}

export const addTotals = (a: PrivateTotals, b: PrivateTotals): PrivateTotals => ({
  lentOut: a.lentOut + b.lentOut,
  owedToYou: a.owedToYou + b.owedToYou,
  borrowed: a.borrowed + b.borrowed,
  youOwe: a.youOwe + b.youOwe,
  waitingForYou: a.waitingForYou + b.waitingForYou,
});
