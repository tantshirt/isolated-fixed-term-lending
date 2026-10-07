/**
 * Loan alerts (Story 24.3). Pure, so the Convex job, the interface and tests agree.
 *
 * Risk is measured on the collateral price buffer: the distance from the baseline price (when the
 * loan started, or was last rebased) down to the price at which the loan reaches its liquidation
 * line. Alerts fire as 25%, 50% and 75% of that buffer is used, then on the absolute remaining
 * buffer at 5% and 2% of the current price, and at liquidation eligibility.
 */
export type RiskLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const LEVEL_WORDS: Record<RiskLevel, string> = {
  0: "Healthy",
  1: "A quarter of the price buffer used",
  2: "Half of the price buffer used",
  3: "Three quarters of the price buffer used",
  4: "Within 5% of liquidation",
  5: "Within 2% of liquidation",
  6: "Can be liquidated now",
};

/** A level drops only after the price recovers this share of the buffer past its threshold. */
export const HYSTERESIS = 0.05;

/**
 * Collateral price (in USD per SOL, float for display math only) at which `payoff` reaches the
 * liquidation LTV for `lamports` of collateral. The program decides with integers; this only
 * places alert bands.
 */
export function liquidationPrice(payoffAtoms: bigint, lamports: bigint, liquidationLtvBps: number): number {
  if (lamports <= 0n || liquidationLtvBps <= 0) return Infinity;
  const payoffUsd = Number(payoffAtoms) / 1e6;
  const sol = Number(lamports) / 1e9;
  return payoffUsd / (sol * (liquidationLtvBps / 10_000));
}

export type RiskInput = { price: number; baseline: number; liquidationPrice: number; eligible: boolean };

/** The raw level for a price, before hysteresis. */
export function rawLevel({ price, baseline, liquidationPrice: lp, eligible }: RiskInput): RiskLevel {
  if (eligible) return 6;
  if (price <= lp) return 5;
  const remaining = (price - lp) / price;
  if (remaining <= 0.02) return 5;
  if (remaining <= 0.05) return 4;
  const buffer = baseline - lp;
  if (buffer <= 0) return 4;
  const used = (baseline - price) / buffer;
  if (used >= 0.75) return 3;
  if (used >= 0.5) return 2;
  if (used >= 0.25) return 1;
  return 0;
}

/** Applies hysteresis: rises at once, falls only after a clear recovery. */
export function nextLevel(previous: RiskLevel, input: RiskInput): RiskLevel {
  const raw = rawLevel(input);
  if (raw >= previous) return raw;
  // Re-evaluate as if the price were a little lower; only fall if that still reads lower.
  const buffer = Math.max(input.baseline - input.liquidationPrice, 0);
  const guarded = rawLevel({ ...input, price: input.price - buffer * HYSTERESIS });
  return guarded < previous ? (Math.max(raw, guarded) as RiskLevel) : previous;
}

export type AlertState = {
  baseline: number;
  /** What the baseline was measured against: a change means a payment or top-up happened. */
  basis: string;
  level: RiskLevel;
  /** Highest level already announced since the last full recovery. */
  notified: RiskLevel;
  reminders: string[];
  /** Increments on recovery/rebase so an old completed send cannot suppress a new warning. */
  cycle?: number;
};

/**
 * One evaluation step. Returns the new state and the alert to send, if any. A changed basis
 * (principal reduced or collateral added) rebases on the current valid price.
 */
export function step(state: AlertState | null, input: Omit<RiskInput, "baseline"> & { basis: string }): { state: AlertState; send: RiskLevel | null } {
  if (!state || state.basis !== input.basis) {
    const fresh: AlertState = { baseline: input.price, basis: input.basis, level: 0, notified: 0, reminders: state?.reminders ?? [], cycle: (state?.cycle ?? 0) + 1 };
    const level = rawLevel({ ...input, baseline: input.price });
    return { state: { ...fresh, level, notified: level }, send: level > 0 && level > (state?.notified ?? 0) ? level : null };
  }
  const level = nextLevel(state.level, { ...input, baseline: state.baseline });
  const notified = level === 0 ? 0 : state.notified;
  const send = level > notified ? level : null;
  return { state: { ...state, level, cycle: (state.cycle ?? 0) + (level === 0 && state.notified > 0 ? 1 : 0), notified: Math.max(notified, send ?? 0) as RiskLevel }, send };
}

export type Reminder = { key: string; at: number; words: string };

/** Deadline reminders for a loan: one day and one hour before the deadline, then each window. */
export function remindersFor(d: { maturity: number; graceEnd?: number; pricedFrom?: number; terminalFrom?: number }): Reminder[] {
  const r: Reminder[] = [
    { key: "maturity-24h", at: d.maturity - 86_400, words: "Your loan is due in 24 hours." },
    { key: "maturity-1h", at: d.maturity - 3_600, words: "Your loan is due in 1 hour." },
  ];
  if (d.graceEnd !== undefined) {
    r.push({ key: "grace-start", at: d.maturity, words: "The deadline has passed. Grace has started and the late fee applies." });
    r.push({ key: "grace-end-1h", at: d.graceEnd - 3_600, words: "Grace ends in 1 hour. After that anyone may settle the loan." });
  }
  if (d.pricedFrom !== undefined) r.push({ key: "priced-recovery", at: d.pricedFrom, words: "Priced recovery is now open on this loan." });
  if (d.terminalFrom !== undefined) {
    r.push({ key: "terminal-24h", at: d.terminalFrom - 86_400, words: "In 24 hours the lender may take all of the collateral." });
    r.push({ key: "terminal", at: d.terminalFrom, words: "The final whole-collateral claim is now open." });
  }
  return r;
}

/** Reminders that are due now and were not sent yet. Old ones (more than a day late) are skipped. */
export function dueReminders(all: Reminder[], sent: string[], now: number): Reminder[] {
  return all.filter((x) => x.at <= now && now - x.at < 86_400 && !sent.includes(x.key));
}

/** Private loans: the server never sees terms, so every message is the same generic line. */
export const GENERIC_PRIVATE_MESSAGE = "You have an update in ZenLo. Open the app to see it.";

export function riskNotificationKey(state: AlertState, level: RiskLevel): string {
  return `risk:${state.basis}:${state.cycle ?? 0}:${level}`;
}
