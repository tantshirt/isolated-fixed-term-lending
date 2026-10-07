// Private V2 rooms (Stories 22.1, 22.2, 24.1): the words and checks the room screen needs. Pure:
// works on records already read through the TEE with the viewer's own token.
import type { PublicKey } from "@solana/web3.js";
import { payoff, phase, sync, type Phase } from "../loan-math-v2";
import type { RoomMessage } from "./room-codec";
import type { LoanTermsV2 } from "./v2-codec";

// ---- borrowing requests: a borrower's thread message; its index is the request number

const REQUEST = /^request (\d+(?:\.\d{1,6})?) USDC for (\d{1,3}) days?$/;

export const requestBody = (usdc: string, days: number) => `request ${usdc} USDC for ${days} ${days === 1 ? "day" : "days"}`;

export type BorrowRequest = { index: number; borrower: PublicKey; principal: bigint; days: number; ts: number };

export function requestsInThread(messages: RoomMessage[]): BorrowRequest[] {
  return messages.flatMap((m) => {
    const r = REQUEST.exec(m.body);
    if (!r) return [];
    const [whole, frac = ""] = r[1].split(".");
    return [{ index: m.index, borrower: m.author, principal: BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0")), days: Number(r[2]), ts: m.ts }];
  });
}

// ---- auditor audience: the desk lender shares it in the room; the borrower checks its hash

const AUDITOR = /^auditor (\d+) ([1-9A-HJ-NP-Za-km-z]{32,44})$/;

export const auditorBody = (roomIndex: number, auditor: PublicKey) => `auditor ${roomIndex} ${auditor.toBase58()}`;

/** Auditor keys the loan's lender posted for this loan, in the order posted. */
export function sharedAuditors(messages: RoomMessage[], loan: Pick<LoanTermsV2, "roomIndex" | "originLender">): string[] {
  const keys: string[] = [];
  for (const m of messages) {
    const r = AUDITOR.exec(m.body);
    if (r && Number(r[1]) === loan.roomIndex && m.author.equals(loan.originLender) && !keys.includes(r[2])) keys.push(r[2]);
  }
  return keys;
}

const ZERO = new Uint8Array(32);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export type Audience =
  | { kind: "none" }
  | { kind: "named"; auditors: string[] }
  /** The terms bind an audience the room does not show (or shows differently): do not sign. */
  | { kind: "unverified" };

/** What the borrower consents to. `hash` is the SHA-256 of the shared keys, computed by the caller. */
export function audienceFor(terms: Pick<LoanTermsV2, "auditorHash">, shared: string[], hash: Uint8Array | null): Audience {
  if (same(terms.auditorHash, ZERO)) return { kind: "none" };
  return hash && shared.length > 0 && same(hash, terms.auditorHash) ? { kind: "named", auditors: shared } : { kind: "unverified" };
}

/** Recover the current audience after a partially completed removal, using the on-chain hash.
 * Before acceptance only the exact published audience is allowed. Removal preserves key order.
 */
export async function resolveAudience(
  terms: Pick<LoanTermsV2, "auditorHash" | "status">,
  shared: string[],
  hash: (keys: string[]) => Promise<Uint8Array>,
): Promise<Audience> {
  const exact = audienceFor(terms, shared, shared.length ? await hash(shared) : null);
  if (exact.kind !== "unverified" || terms.status !== "active" || shared.length > 4) return exact;
  for (let mask = 1; mask < (1 << shared.length) - 1; mask++) {
    const remaining = shared.filter((_, index) => (mask & (1 << index)) !== 0);
    const candidate = audienceFor(terms, remaining, await hash(remaining));
    if (candidate.kind === "named") return candidate;
  }
  return exact;
}

/** A full-payoff signature permits two minutes of accrual; the program takes only the payoff. */
export const PAYOFF_SIGNING_ALLOWANCE = 120;
export function fullPayoffAmount(t: Pick<LoanTermsV2, "terms" | "ledger">, now: number): bigint {
  return payoff(t.terms, t.ledger, now + PAYOFF_SIGNING_ALLOWANCE);
}

// ---- who can do what next

export type V2Action = "fund" | "cancel" | "accept" | "repay" | "top-up" | "claim-priced" | "claim-terminal" | "share-auditors";

export type V2LoanState = {
  role: "lender" | "borrower" | "reader";
  phase: Phase | null;
  payoff: bigint | null;
  actions: V2Action[];
  /** One sentence: what happens next and who does it. */
  next: string;
};

export function v2LoanState(t: LoanTermsV2, me: PublicKey, now: number): V2LoanState {
  const role = t.currentLender.equals(me) ? "lender" : t.borrower.equals(me) ? "borrower" : "reader";
  const running = t.status === "active";
  const p = running ? phase(t.terms, now) : null;
  const owed = running ? payoff(t.terms, sync(t.terms, t.ledger, now), now) : null;
  const actions: V2Action[] = [];
  let next = "";
  const hasDesk = t.desk !== null;
  switch (t.status) {
    case "draft":
      if (role === "lender") actions.push("fund", "cancel");
      if (role === "lender" && hasDesk) actions.push("share-auditors");
      next = role === "lender" ? "Lock the USDC to make this offer live." : "Waiting for the lender to lock the USDC.";
      break;
    case "funded":
      if (role === "lender") actions.push("cancel");
      if (role === "lender" && hasDesk) actions.push("share-auditors");
      if (role === "borrower") actions.push("accept");
      next = role === "borrower" ? "Review the terms, then lock wSOL to borrow." : "Waiting for the borrower to accept.";
      break;
    case "active":
      if (role === "borrower") actions.push("repay", "top-up");
      if (role === "lender" && (p === "PricedRecovery" || p === "Terminal")) actions.push("claim-priced");
      if (role === "lender" && p === "Terminal") actions.push("claim-terminal");
      next =
        p === "Active"
          ? "Waiting for repayment."
          : p === "Grace"
            ? "Past the due date. Repaying now adds the one-time late fee."
            : p === "Overdue"
              ? "Grace has ended. Anyone can pay what is owed and take wSOL worth that plus 5%; the rest returns to the borrower."
              : p === "PricedRecovery"
                ? "The lender can take collateral worth what is owed, at the market price."
                : "The lender can take all of the wSOL, even if it is worth more than what is owed.";
      break;
    case "repaid":
      next = "Repaid. The collateral went back to the borrower.";
      break;
    case "cancelled":
      next = "Cancelled.";
      break;
    default:
      next = "Settled.";
  }
  return { role, phase: p, payoff: owed, actions, next };
}
