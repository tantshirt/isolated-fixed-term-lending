/**
 * Repayment rules a V2 offer or request fixes at creation (Stories 20.2, 21.1). The wizard keeps
 * them next to the V1 fields; the program receives them as `TermsArgs`.
 */
import {
  DEFAULT_GRACE_SECONDS,
  DEFAULT_LATE_FEE_BPS,
  DEFAULT_MIN_INTEREST_BPS,
  EarlyRepayment,
  PROTOCOL_MAX_ANNUAL_CEILING_BPS,
  SECONDS_PER_YEAR,
  annualizedBps,
  chargeCeiling,
  fullTermInterest,
  graceEnd,
  maturity,
  maxExposure,
  minInterest,
  terminalClaimFrom,
  pricedRecoveryFrom,
  validateTermsV2,
  type TermsV2,
} from "../loan-math-v2";
import type { TermsInput } from "./transactions";

export type RepaymentRules = {
  earlyRepayment: "pro-rata" | "full-term";
  graceSeconds: number;
  lateFeeBps: number;
  /** null means "suggest one": the lowest 5% step that fits the interest and the late fee. */
  annualCeilingBps: number | null;
};

export const DEFAULT_RULES: RepaymentRules = {
  earlyRepayment: "pro-rata",
  graceSeconds: DEFAULT_GRACE_SECONDS,
  lateFeeBps: DEFAULT_LATE_FEE_BPS,
  annualCeilingBps: null,
};

export const GRACE_CHOICES = [86_400, 129_600, 172_800] as const;

export function readRules(raw: unknown): RepaymentRules {
  const r = (raw ?? {}) as Partial<RepaymentRules>;
  return {
    earlyRepayment: r.earlyRepayment === "full-term" ? "full-term" : "pro-rata",
    graceSeconds: GRACE_CHOICES.includes(r.graceSeconds as never) ? (r.graceSeconds as number) : DEFAULT_GRACE_SECONDS,
    lateFeeBps: Number.isInteger(r.lateFeeBps) && r.lateFeeBps! >= 0 && r.lateFeeBps! <= 500 ? r.lateFeeBps! : DEFAULT_LATE_FEE_BPS,
    annualCeilingBps: Number.isInteger(r.annualCeilingBps) ? r.annualCeilingBps! : null,
  };
}

/** The lowest ceiling, in 5% steps, under which the full-term interest and the late fee both fit. */
export function suggestCeilingBps(principal: bigint, interestBps: number, duration: number, rules: Pick<RepaymentRules, "graceSeconds" | "lateFeeBps">): number | null {
  if (principal <= 0n || duration <= 0) return null;
  const full = (principal * BigInt(interestBps) + 9_999n) / 10_000n;
  const fee = (principal * BigInt(rules.lateFeeBps) + 9_999n) / 10_000n;
  const period = BigInt(duration + rules.graceSeconds);
  const needed = ((full + fee) * 10_000n * SECONDS_PER_YEAR + principal * period - 1n) / (principal * period);
  const stepped = Math.max(500, Math.ceil(Number(needed) / 500) * 500);
  return stepped <= PROTOCOL_MAX_ANNUAL_CEILING_BPS ? stepped : null;
}

export function termsFrom(
  base: { principal: bigint; interestBps: number; durationSeconds: number },
  rules: RepaymentRules,
  startTs = 0,
): TermsV2 | null {
  const ceiling = rules.annualCeilingBps ?? suggestCeilingBps(base.principal, base.interestBps, base.durationSeconds, rules);
  if (ceiling === null) return null;
  return {
    principal: base.principal,
    interestBps: base.interestBps,
    duration: base.durationSeconds,
    startTs,
    earlyRepayment: rules.earlyRepayment === "pro-rata" ? EarlyRepayment.ProRata : EarlyRepayment.FullTerm,
    minInterestBps: DEFAULT_MIN_INTEREST_BPS,
    graceSeconds: rules.graceSeconds,
    lateFeeBps: rules.lateFeeBps,
    annualCeilingBps: ceiling,
  };
}

/** A user-facing problem with the rules, or null. */
export function rulesProblem(base: { principal: bigint | null; interestBps: number; durationSeconds: number }, rules: RepaymentRules): string | null {
  if (base.principal === null || base.principal <= 0n) return null;
  const t = termsFrom({ principal: base.principal, interestBps: base.interestBps, durationSeconds: base.durationSeconds }, rules);
  if (!t) return "This rate is above the highest pricing ceiling ZenLo allows for this term. Lower the rate or lengthen the term.";
  return validateTermsV2(t);
}

export function termsInput(t: TermsV2, risk: { collateralAmount: bigint; maxLtvBps: number; liquidationLtvBps: number }): TermsInput {
  const { startTs: _unused, ...rest } = t;
  void _unused;
  return { ...rest, ...risk };
}

/** Every figure a signing review shows, from the same math the program runs. */
export function reviewFigures(t: TermsV2, startTs: number) {
  const started = { ...t, startTs };
  return {
    termCost: fullTermInterest(t),
    annualizedBps: annualizedBps(t),
    ceilingBps: t.annualCeilingBps,
    chargeCeiling: chargeCeiling(t),
    minInterest: minInterest(t),
    maxExposure: maxExposure(t),
    lateFeeMax: (t.principal * BigInt(t.lateFeeBps) + 9_999n) / 10_000n,
    maturity: maturity(started),
    graceEnd: graceEnd(started),
    pricedRecoveryFrom: pricedRecoveryFrom(started),
    terminalClaimFrom: terminalClaimFrom(started),
  };
}
