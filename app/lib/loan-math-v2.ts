/**
 * V2 accounting, mirroring crates/loan-core/src/accounting.rs line for line. Parity is proven by
 * crates/loan-core/vectors-v2.json, replayed in Rust and in isolated_loan/tests/loan-math.test.ts.
 * All amounts are bigint atoms. Formulas and rounding are stated in docs/research.md.
 */
import { collateralValueUsdc, currentLtvBps, interest, seizeUsdc, wsolToCaller } from "./loan-math";
import { CAPS } from "./constants";

export const SECONDS_PER_YEAR = 31_536_000n;
export const DEFAULT_GRACE_SECONDS = 86_400;
export const MIN_GRACE_SECONDS = 86_400;
export const MAX_GRACE_SECONDS = 172_800;
export const DEFAULT_LATE_FEE_BPS = 100;
export const MAX_LATE_FEE_BPS = 500;
export const DEFAULT_MIN_INTEREST_BPS = 2_500;
/** Devnet test setting: the highest annual pricing ceiling any V2 loan may declare (600%). */
export const PROTOCOL_MAX_ANNUAL_CEILING_BPS = 60_000;
export const PRICED_RECOVERY_DELAY = 86_400;
export const TERMINAL_CLAIM_DELAY = 604_800;
export const EMERGENCY_LTV_MARGIN_BPS = 300;

export enum EarlyRepayment {
  FullTerm = 0,
  ProRata = 1,
}

export type TermsV2 = {
  principal: bigint;
  interestBps: number;
  duration: number;
  startTs: number;
  earlyRepayment: EarlyRepayment;
  minInterestBps: number;
  graceSeconds: number;
  lateFeeBps: number;
  annualCeilingBps: number;
};

export type Ledger = {
  outstandingPrincipal: bigint;
  interestAccrued: bigint;
  interestPaid: bigint;
  accrualRemainder: bigint;
  lastAccrualTs: number;
  lateFeeAssessed: bigint;
  lateFeePaid: bigint;
  lateFeeChecked: boolean;
};

export type Payment = { used: bigint; interest: bigint; lateFee: bigint; principal: bigint; adjustment: bigint; closed: boolean };
export type Phase = "Active" | "Grace" | "Overdue" | "PricedRecovery" | "Terminal";

const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const sat = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

export const maturity = (t: TermsV2) => t.startTs + t.duration;
export const graceEnd = (t: TermsV2) => maturity(t) + t.graceSeconds;
export const pricedRecoveryFrom = (t: TermsV2) => graceEnd(t) + PRICED_RECOVERY_DELAY;
export const terminalClaimFrom = (t: TermsV2) => graceEnd(t) + TERMINAL_CLAIM_DELAY;
export const fullTermInterest = (t: TermsV2) => interest(t.principal, t.interestBps);

export function chargeCeiling(t: TermsV2): bigint {
  return (t.principal * BigInt(t.annualCeilingBps) * BigInt(t.duration + t.graceSeconds)) / (10_000n * SECONDS_PER_YEAR);
}

export function minInterest(t: TermsV2): bigint {
  if (t.earlyRepayment === EarlyRepayment.FullTerm) return 0n;
  return min(ceilDiv(fullTermInterest(t) * BigInt(t.minInterestBps), 10_000n), chargeCeiling(t));
}

export function maxExposure(t: TermsV2): bigint {
  const fee = ceilDiv(t.principal * BigInt(t.lateFeeBps), 10_000n);
  return t.principal + min(fullTermInterest(t) + fee, chargeCeiling(t));
}

/** Null when valid; otherwise the first rule the terms break, in words a form can show. */
export function validateTermsV2(t: TermsV2): string | null {
  if (t.principal <= 0n) return "Principal must be above zero.";
  if (t.interestBps > CAPS.maxInterestBps) return "Term interest is above the 20% cap.";
  if (t.duration < CAPS.minDurationSeconds || t.duration > CAPS.maxDurationSeconds) return "Duration must be between 60 seconds and 90 days.";
  if (t.graceSeconds < MIN_GRACE_SECONDS || t.graceSeconds > MAX_GRACE_SECONDS) return "Grace must be between 24 and 48 hours.";
  if (t.lateFeeBps > MAX_LATE_FEE_BPS) return "The late fee can be at most 5%.";
  if (t.minInterestBps > 10_000) return "The minimum interest can be at most the full-term interest.";
  if (t.annualCeilingBps <= 0 || t.annualCeilingBps > PROTOCOL_MAX_ANNUAL_CEILING_BPS) return "The annual pricing ceiling must be above 0% and at most 600%.";
  if (fullTermInterest(t) > chargeCeiling(t)) return "The term interest is above the annual pricing ceiling for this duration.";
  return null;
}

export function openLedger(t: TermsV2): Ledger {
  const problem = validateTermsV2(t);
  if (problem) throw new Error(problem);
  return {
    outstandingPrincipal: t.principal,
    interestAccrued: t.earlyRepayment === EarlyRepayment.FullTerm ? fullTermInterest(t) : 0n,
    interestPaid: 0n,
    accrualRemainder: 0n,
    lastAccrualTs: t.startTs,
    lateFeeAssessed: 0n,
    lateFeePaid: 0n,
    lateFeeChecked: false,
  };
}

export function phase(t: TermsV2, now: number): Phase {
  if (now < maturity(t)) return "Active";
  if (now < graceEnd(t)) return "Grace";
  if (now < pricedRecoveryFrom(t)) return "Overdue";
  if (now < terminalClaimFrom(t)) return "PricedRecovery";
  return "Terminal";
}

const headroom = (t: TermsV2, l: Ledger) => sat(chargeCeiling(t), l.interestPaid + l.interestAccrued + l.lateFeeAssessed);

export function accrue(t: TermsV2, l: Ledger, now: number): Ledger {
  if (t.earlyRepayment !== EarlyRepayment.ProRata) return l;
  const at = Math.min(now, maturity(t));
  if (at <= l.lastAccrualTs) return l;
  const den = 10_000n * BigInt(t.duration);
  const num = l.outstandingPrincipal * BigInt(t.interestBps) * BigInt(at - l.lastAccrualTs) + l.accrualRemainder;
  let whole = num / den;
  let remainder = num % den;
  // At maturity the term's interest is complete: round up once, before any late fee.
  if (at === maturity(t) && remainder > 0n) {
    whole += 1n;
    remainder = 0n;
  }
  return { ...l, interestAccrued: l.interestAccrued + min(whole, headroom(t, l)), accrualRemainder: remainder, lastAccrualTs: at };
}

export function assessLateFee(t: TermsV2, l: Ledger, now: number): Ledger {
  if (now < maturity(t) || l.lateFeeChecked) return l;
  const fee = ceilDiv(l.outstandingPrincipal * BigInt(t.lateFeeBps), 10_000n);
  return { ...l, lateFeeAssessed: min(fee, headroom(t, l)), lateFeeChecked: true };
}

export const sync = (t: TermsV2, l: Ledger, now: number) => assessLateFee(t, accrue(t, l, now), now);

function finalAdjustment(t: TermsV2, l: Ledger): bigint {
  if (t.earlyRepayment !== EarlyRepayment.ProRata) return 0n;
  const room = headroom(t, l);
  const roundup = min(l.accrualRemainder > 0n ? 1n : 0n, room);
  const floorGap = sat(minInterest(t), l.interestPaid + l.interestAccrued + roundup);
  return roundup + min(floorGap, room - roundup);
}

export function payoff(t: TermsV2, ledger: Ledger, now: number): bigint {
  const l = sync(t, ledger, now);
  return l.outstandingPrincipal + l.interestAccrued + (l.lateFeeAssessed - l.lateFeePaid) + finalAdjustment(t, l);
}

export function applyPayment(t: TermsV2, ledger: Ledger, now: number, amount: bigint): [Ledger, Payment] {
  if (amount <= 0n) throw new Error("A payment must be above zero.");
  const l = sync(t, ledger, now);
  const lateDue = l.lateFeeAssessed - l.lateFeePaid;
  const total = payoff(t, l, now);
  if (amount >= total) {
    const adjustment = finalAdjustment(t, l);
    return [
      { ...l, interestPaid: l.interestPaid + l.interestAccrued + adjustment, interestAccrued: 0n, accrualRemainder: 0n, lateFeePaid: l.lateFeeAssessed, outstandingPrincipal: 0n },
      { used: total, interest: l.interestAccrued, lateFee: lateDue, principal: l.outstandingPrincipal, adjustment, closed: true },
    ];
  }
  let left = amount;
  const toInterest = min(left, l.interestAccrued);
  left -= toInterest;
  const toLate = min(left, lateDue);
  left -= toLate;
  const toPrincipal = min(left, l.outstandingPrincipal);
  left -= toPrincipal;
  return [
    { ...l, interestAccrued: l.interestAccrued - toInterest, interestPaid: l.interestPaid + toInterest, lateFeePaid: l.lateFeePaid + toLate, outstandingPrincipal: l.outstandingPrincipal - toPrincipal },
    { used: amount - left, interest: toInterest, lateFee: toLate, principal: toPrincipal, adjustment: 0n, closed: false },
  ];
}

export type LiquidationKind = "Ordinary" | "Emergency";

export function liquidationTrigger(spotLtvBps: number, emaLtvBps: number | null, thresholdBps: number): LiquidationKind | null {
  if (spotLtvBps >= thresholdBps && emaLtvBps !== null && emaLtvBps >= thresholdBps) return "Ordinary";
  if (spotLtvBps >= Math.min(65_535, thresholdBps + EMERGENCY_LTV_MARGIN_BPS)) return "Emergency";
  return null;
}

export function ltvBps(payoffAtoms: bigint, lamports: bigint, price: bigint, conf: bigint, exponent: number): number {
  return currentLtvBps(payoffAtoms, collateralValueUsdc(lamports, price, conf, exponent));
}

export type CollateralSplit = { toRecipient: bigint; toBorrower: bigint; shortfall: bigint };

export function liquidationSplit(payoffAtoms: bigint, lamports: bigint, valueUsdc: bigint): CollateralSplit {
  const toCaller = wsolToCaller(lamports, seizeUsdc(payoffAtoms), valueUsdc);
  return { toRecipient: toCaller, toBorrower: lamports - toCaller, shortfall: 0n };
}

export function pricedRecoverySplit(payoffAtoms: bigint, lamports: bigint, valueUsdc: bigint): CollateralSplit {
  const toLender = wsolToCaller(lamports, payoffAtoms, valueUsdc);
  return { toRecipient: toLender, toBorrower: lamports - toLender, shortfall: sat(payoffAtoms, valueUsdc) };
}

/** Display only: the term rate annualized on a 365-day year, in basis points, rounded down. */
export function annualizedBps(t: Pick<TermsV2, "interestBps" | "duration">): number {
  return Number((BigInt(t.interestBps) * SECONDS_PER_YEAR) / BigInt(t.duration));
}
