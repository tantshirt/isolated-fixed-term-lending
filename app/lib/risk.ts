import { collateralValueUsdc, currentLtvBps } from "./loan-math";

export type Price = { price: bigint; conf: bigint; exponent: number };

/**
 * Smallest wSOL amount whose conservative value keeps `debt` at or under `ltvBps`.
 * Same rounding as the program: the result is checked against `currentLtvBps`.
 */
export function minCollateralLamports(debtAtoms: bigint, ltvBps: number, p: Price): bigint {
  if (ltvBps <= 0) return 0n;
  const conservative = p.price - p.conf;
  if (conservative <= 0n) return 0n;
  const divisor = 10n ** BigInt(3 - p.exponent);
  // value >= debt * 10_000 / ltv  →  lamports >= that * divisor / conservative
  const needValue = (debtAtoms * 10_000n + BigInt(ltvBps) - 1n) / BigInt(ltvBps);
  let lamports = (needValue * divisor + conservative - 1n) / conservative;
  while (currentLtvBps(debtAtoms, collateralValueUsdc(lamports, p.price, p.conf, p.exponent)) > ltvBps) {
    lamports += 1n;
  }
  return lamports;
}

/** SOL/USD (as a float, display only) at which the loan reaches `ltvBps`. */
export function solPriceAtLtv(debtAtoms: bigint, lamports: bigint, ltvBps: number): number {
  if (lamports === 0n || ltvBps === 0) return 0;
  // value_usdc = debt * 10_000 / ltv; price = value_usdc / lamports scaled 6 → 9 decimals
  const valueUsdc = Number(debtAtoms) * 10_000 / ltvBps / 1e6;
  return valueUsdc / (Number(lamports) / 1e9);
}

/** Price as a float in USD, display only. */
export function priceUsd(p: Price): number {
  return Number(p.price) * 10 ** p.exponent;
}

/** LTV of a planned loan at a given price, in bps. */
export function plannedLtvBps(debtAtoms: bigint, lamports: bigint, p: Price): number {
  return currentLtvBps(debtAtoms, collateralValueUsdc(lamports, p.price, p.conf, p.exponent));
}
