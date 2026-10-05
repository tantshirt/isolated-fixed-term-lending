/** Integer loan math — matches isolated_loan program and docs/research.md worked example. */

export const BPS_SCALE = 10_000;
export const USDC_DECIMALS = 6;
export const WSOL_DECIMALS = 9;

export function interest(principal: bigint, interestBps: number): bigint {
  return (principal * BigInt(interestBps) + 9_999n) / BigInt(BPS_SCALE);
}

export function debt(principal: bigint, interestBps: number): bigint {
  return principal + interest(principal, interestBps);
}

export function collateralValueUsdc(
  lamports: bigint,
  price: bigint,
  conf: bigint,
  exponent: number,
): bigint {
  if (price <= 0n) throw new Error("Invalid price");
  if (conf >= price) throw new Error("Invalid confidence");
  if (exponent < -12 || exponent > -3) throw new Error("Invalid exponent");

  const conservative = price - conf;
  const divisorExp = 3 - exponent;
  const divisor = 10n ** BigInt(divisorExp);
  return (lamports * conservative) / divisor;
}

/** The program stores LTV as u16 and saturates, so a collapsed loan still reads as liquidatable. */
export const LTV_SATURATED_BPS = 65_535;

export function currentLtvBps(debtAtoms: bigint, valueUsdc: bigint): number {
  if (valueUsdc === 0n) return LTV_SATURATED_BPS;
  const num = debtAtoms * BigInt(BPS_SCALE);
  const ltv = (num + valueUsdc - 1n) / valueUsdc;
  return ltv > BigInt(LTV_SATURATED_BPS) ? LTV_SATURATED_BPS : Number(ltv);
}

export function healthBps(currentLtvBps: number, liquidationLtvBps: number): number {
  if (liquidationLtvBps === 0) return 0;
  const health =
    10_000 - Math.floor((currentLtvBps * 10_000) / liquidationLtvBps);
  return Math.max(0, health);
}

export function seizeUsdc(debtAtoms: bigint): bigint {
  return (debtAtoms * 10_500n + 9_999n) / 10_000n;
}

export function wsolToCaller(
  lamports: bigint,
  seizeUsdcAtoms: bigint,
  valueUsdc: bigint,
): bigint {
  if (valueUsdc === 0n) throw new Error("Zero collateral value");
  const num = lamports * seizeUsdcAtoms;
  const toCaller = (num + valueUsdc - 1n) / valueUsdc;
  return toCaller > lamports ? lamports : toCaller;
}

/** Worked example sanity check (149.85 USDC per wSOL, debt 105 for 100 @ 5%). */
export function assertWorkedExample(): void {
  const price = 15_000_000_000n;
  const conf = 15_000_000n;
  const exponent = -8;
  const oneWsol = 1_000_000_000n;
  const value = collateralValueUsdc(oneWsol, price, conf, exponent);
  if (value !== 149_850_000n) {
    throw new Error(`Expected 149_850_000 USDC atoms, got ${value}`);
  }

  const principal = 100_000_000n;
  const interestBps = 500;
  if (interest(principal, interestBps) !== 5_000_000n) {
    throw new Error("Interest mismatch");
  }
  if (debt(principal, interestBps) !== 105_000_000n) {
    throw new Error("Debt mismatch");
  }
}
