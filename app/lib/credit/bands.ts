/**
 * Credit tiers (Story 26.7, research.md § Credit tiers). Pure and server-safe.
 *
 * A verified monthly income (whole US dollars, from a Reclaim proof) maps to a band, and a band to
 * a tier. Only the tier ever leaves the server; the income figure is used once here and dropped.
 *
 * | Band   | Verified monthly income | Tier | Max LTV | Liquidation | Emergency |
 * | ------ | ----------------------- | ---- | ------- | ----------- | --------- |
 * | below  | under $2,000            | none | standard caps (70% / 85%)         |
 * | entry  | $2,000 to $4,999        | 1    | 80%     | 85%         | 88%       |
 * | middle | $5,000 to $9,999        | 2    | 85%     | 90%         | 93%       |
 * | upper  | $10,000 and above       | 3    | 88%     | 93%         | 96%       |
 *
 * The thresholds are a pilot choice, not underwriting advice. Liquidation is always max + 5 points
 * and emergency liquidation a further 3 points, as in the research note.
 */
export type CreditTier = 1 | 2 | 3;
export type IncomeBand = "below" | "entry" | "middle" | "upper";

export const BAND_FLOORS_USD: Readonly<Record<Exclude<IncomeBand, "below">, number>> = { entry: 2_000, middle: 5_000, upper: 10_000 };

export const TIER_CAPS: Readonly<Record<CreditTier, { maxLtvBps: number; liquidationLtvBps: number; emergencyLtvBps: number }>> = {
  1: { maxLtvBps: 8_000, liquidationLtvBps: 8_500, emergencyLtvBps: 8_800 },
  2: { maxLtvBps: 8_500, liquidationLtvBps: 9_000, emergencyLtvBps: 9_300 },
  3: { maxLtvBps: 8_800, liquidationLtvBps: 9_300, emergencyLtvBps: 9_600 },
};

/** A credential lasts 180 days from issue; the tier on a loan stays fixed past that. */
export const CREDENTIAL_LIFETIME_SECONDS = 180 * 86_400;

export function bandFor(monthlyIncomeUsd: number): IncomeBand {
  if (!Number.isFinite(monthlyIncomeUsd) || monthlyIncomeUsd < BAND_FLOORS_USD.entry) return "below";
  if (monthlyIncomeUsd < BAND_FLOORS_USD.middle) return "entry";
  if (monthlyIncomeUsd < BAND_FLOORS_USD.upper) return "middle";
  return "upper";
}

export function tierFor(band: IncomeBand): CreditTier | null {
  return band === "entry" ? 1 : band === "middle" ? 2 : band === "upper" ? 3 : null;
}

/**
 * Reads the provider's extracted income string strictly: digits with optional thousands commas,
 * an optional leading "$" and an optional decimal part. Anything else is unreadable (null), never
 * guessed, so a malformed proof can only fail closed.
 */
export function parseIncome(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^\$/, "");
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Standard caps without a credential (research.md § Collateral). */
export const STANDARD_CAPS = { maxLtvBps: 7_000, liquidationLtvBps: 8_500 } as const;

/**
 * Lowest tier whose caps cover these terms: 0 within the standard caps, null if no tier does.
 * Mirrors the program's `credit::required_tier`.
 */
export function requiredTier(maxLtvBps: number, liquidationLtvBps: number): 0 | CreditTier | null {
  if (maxLtvBps <= STANDARD_CAPS.maxLtvBps && liquidationLtvBps <= STANDARD_CAPS.liquidationLtvBps) return 0;
  for (const t of [1, 2, 3] as const) if (maxLtvBps <= TIER_CAPS[t].maxLtvBps && liquidationLtvBps <= TIER_CAPS[t].liquidationLtvBps) return t;
  return null;
}

export const tierLabel =(tier: number) => (tier >= 1 && tier <= 3 ? `Tier ${tier}` : "Standard");
