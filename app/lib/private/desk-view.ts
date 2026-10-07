// Desk workspace view model (Story 23.2). Pure: works on records already read through the TEE
// with the viewer's own token. A loan the viewer cannot read stays "not shared", never zero.
import type { PublicKey } from "@solana/web3.js";
import {
  MAX_GRACE_SECONDS,
  MAX_LATE_FEE_BPS,
  MIN_GRACE_SECONDS,
  PROTOCOL_MAX_ANNUAL_CEILING_BPS,
  graceEnd,
  maturity,
  payoff,
  phase,
  pricedRecoveryFrom,
  sync,
  terminalClaimFrom,
  type Phase,
} from "../loan-math-v2";
import { DESK_ROLE, MAX_AUDITORS, REPAYMENT_MODE, hasRole, type DeskPolicyV2, type DeskStateV2, type LoanTermsV2 } from "./v2-codec";

export type DeskRoleName = keyof typeof DESK_ROLE;
export const DESK_ROLE_WORDS: Record<DeskRoleName, string> = { admin: "Administrator", lender: "Lender", auditor: "Auditor" };

export function roleNames(roles: number): DeskRoleName[] {
  return (Object.keys(DESK_ROLE) as DeskRoleName[]).filter((r) => hasRole(roles, DESK_ROLE[r]));
}

export type BookEntry = { seq: number; loan: PublicKey; terms: LoanTermsV2 | null };

export type DeskLoanRow =
  | { seq: number; loan: PublicKey; access: "not-shared" }
  | {
      seq: number;
      loan: PublicKey;
      access: "readable";
      terms: LoanTermsV2;
      /** The lender wallet that funded it: desks never pool funds. */
      fundingWallet: PublicKey;
      /** True when this viewer funded it. */
      mine: boolean;
      /** The wallet now holding the lender position, when it moved from the funder. */
      holder: PublicKey | null;
      phase: Phase | null;
      payoff: bigint | null;
      nextDeadline: { label: string; at: number } | null;
      /** What has to happen next, in words, or null when nothing is waiting. */
      waiting: string | null;
      urgent: boolean;
    };

const URGENT_WITHIN = 72 * 3600;

function nextDeadline(t: LoanTermsV2, now: number): { label: string; at: number } | null {
  const steps: [string, number][] = [
    ["Due", maturity(t.terms)],
    ["Grace ends", graceEnd(t.terms)],
    ["Priced recovery opens", pricedRecoveryFrom(t.terms)],
    ["Collateral can be claimed", terminalClaimFrom(t.terms)],
  ];
  const next = steps.find(([, at]) => at > now);
  return next ? { label: next[0], at: next[1] } : null;
}

export function deskLoanRow(e: BookEntry, me: PublicKey, now: number): DeskLoanRow {
  if (!e.terms) return { seq: e.seq, loan: e.loan, access: "not-shared" };
  const t = e.terms;
  const running = t.status === "active";
  const p = running ? phase(t.terms, now) : null;
  const due = running ? nextDeadline(t, now) : null;
  const mine = t.originLender.equals(me);
  const holdsDraft = t.currentLender.equals(me);
  const waiting =
    t.status === "draft"
      ? holdsDraft
        ? "You fund this offer"
        : "Lender to fund"
      : t.status === "funded"
        ? "Borrower to accept"
        : p && p !== "Active"
          ? p === "Grace"
            ? "Past due, in grace"
            : p === "Overdue"
              ? "Overdue: recovery is open"
              : p === "PricedRecovery"
                ? "Priced recovery is open"
                : "Collateral can be claimed"
          : p === "Active" && due && due.at - now <= URGENT_WITHIN
            ? "Due soon"
            : null;
  return {
    seq: e.seq,
    loan: e.loan,
    access: "readable",
    terms: t,
    fundingWallet: t.originLender,
    mine,
    holder: t.currentLender.equals(t.originLender) ? null : t.currentLender,
    phase: p,
    payoff: running ? payoff(t.terms, sync(t.terms, t.ledger, now), now) : null,
    nextDeadline: due,
    waiting,
    urgent: (p !== null && p !== "Active") || (due !== null && due.at - now <= URGENT_WITHIN) || (t.status === "draft" && holdsDraft),
  };
}

export type DeskOverview = {
  myRoles: DeskRoleName[];
  canAdminister: boolean;
  canLend: boolean;
  /** Needs attention first: past due, close to a deadline, or waiting for this wallet. */
  urgent: DeskLoanRow[];
  /** Waiting for a signature from a lender or borrower. */
  pending: DeskLoanRow[];
  running: number;
  notShared: number;
  /** Outstanding principal of running loans this viewer can read: a loan-book total, not a treasury. */
  bookTotal: bigint;
};

export function deskOverview(state: DeskStateV2, me: PublicKey, rows: DeskLoanRow[]): DeskOverview {
  const roles = state.members.find((m) => m.pubkey.equals(me))?.roles ?? 0;
  const readable = rows.filter((r): r is Extract<DeskLoanRow, { access: "readable" }> => r.access === "readable");
  const byUrgency = (a: (typeof readable)[number], b: (typeof readable)[number]) =>
    (a.nextDeadline?.at ?? Number.MAX_SAFE_INTEGER) - (b.nextDeadline?.at ?? Number.MAX_SAFE_INTEGER);
  return {
    myRoles: roleNames(roles),
    canAdminister: hasRole(roles, DESK_ROLE.admin),
    canLend: hasRole(roles, DESK_ROLE.lender),
    urgent: readable.filter((r) => r.urgent && r.terms.status === "active").sort(byUrgency),
    pending: readable.filter((r) => r.terms.status === "draft" || r.terms.status === "funded"),
    running: readable.filter((r) => r.terms.status === "active").length,
    notShared: rows.length - readable.length,
    bookTotal: readable.filter((r) => r.terms.status === "active").reduce((t, r) => t + r.terms.ledger.outstandingPrincipal, 0n),
  };
}

const days = (s: number) => {
  const d = s / 86_400;
  return `${Number.isInteger(d) ? d : d.toFixed(1)} ${d === 1 ? "day" : "days"}`;
};
const pct = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const usdc = (atoms: bigint) => `${(Number(atoms) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`;

/** The policy in words, in the order a borrower reads it. */
export function policyRows(p: DeskPolicyV2): [string, string][] {
  const modes = [p.repaymentModes & REPAYMENT_MODE.proRata ? "interest for days used" : null, p.repaymentModes & REPAYMENT_MODE.fullTerm ? "full-term interest" : null]
    .filter(Boolean)
    .join(" or ");
  return [
    ["Loan size", `${usdc(p.minPrincipal)} to ${usdc(p.maxPrincipal)}`],
    ["Term", `${days(p.minDurationSeconds)} to ${days(p.maxDurationSeconds)}`],
    ["Annual pricing ceiling", `up to ${pct(p.maxAnnualCeilingBps)}`],
    ["Interest for the term", `up to ${pct(p.maxInterestBps)}`],
    ["Early repayment", modes.charAt(0).toUpperCase() + modes.slice(1)],
    ["Starting LTV", `up to ${pct(p.maxLtvBps)}`],
    ["Liquidation LTV", `up to ${pct(p.maxLiquidationLtvBps)}`],
    ["Grace after the due date", `at least ${days(p.minGraceSeconds)}`],
    ["Late fee", `up to ${pct(p.maxLateFeeBps)} of unpaid principal`],
    ["Auditors", p.auditors.length === 0 ? "None" : `${p.auditors.length} read-only, shown to the borrower before signing`],
  ];
}

export type PolicyDraft = Omit<DeskPolicyV2, "version" | "publishedAt">;

/** Mirrors `PolicyArgs::validate` plus the protocol bounds, so a bad policy is caught before signing. */
export function policyDraftProblem(p: PolicyDraft): string | null {
  if (p.maxAnnualCeilingBps <= 0) return "Set an annual pricing ceiling.";
  if (p.maxAnnualCeilingBps > PROTOCOL_MAX_ANNUAL_CEILING_BPS) return "The annual pricing ceiling is above ZenLo's Devnet limit.";
  if (p.maxPrincipal <= 0n || p.minPrincipal > p.maxPrincipal) return "The smallest loan must not be larger than the largest.";
  if (p.minDurationSeconds <= 0 || p.minDurationSeconds > p.maxDurationSeconds) return "The shortest term must not be longer than the longest.";
  if (p.repaymentModes === 0) return "Allow at least one early-repayment rule.";
  if (p.maxLtvBps >= p.maxLiquidationLtvBps) return "The starting LTV must be below the liquidation LTV.";
  if (p.minGraceSeconds < MIN_GRACE_SECONDS || p.minGraceSeconds > MAX_GRACE_SECONDS) return "Grace must be between 1 and 2 days.";
  if (p.maxLateFeeBps > MAX_LATE_FEE_BPS) return "The late fee can be at most 5%.";
  if (p.auditors.length > MAX_AUDITORS) return `A desk can name at most ${MAX_AUDITORS} auditors.`;
  return null;
}

export const DEFAULT_POLICY: PolicyDraft = {
  minPrincipal: 10_000_000n,
  maxPrincipal: 1_000_000_000n,
  minDurationSeconds: 7 * 86_400,
  maxDurationSeconds: 90 * 86_400,
  maxAnnualCeilingBps: 3_000,
  maxInterestBps: 1_000,
  repaymentModes: REPAYMENT_MODE.proRata,
  maxLtvBps: 6_000,
  maxLiquidationLtvBps: 8_000,
  minGraceSeconds: 86_400,
  maxLateFeeBps: 100,
  auditors: [],
};
