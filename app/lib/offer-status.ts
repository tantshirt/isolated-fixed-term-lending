import {
  collateralValueUsdc,
  currentLtvBps,
  debt,
  healthBps,
  seizeUsdc,
  wsolToCaller,
} from "./loan-math";
import type { Offer, StatusKey } from "./offers";

export type PriceSnapshot = {
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: number;
  fresh: boolean;
  /** EMA from the same update, when the reader supplied it. */
  ema?: { price: bigint; conf: bigint };
};

/** Copy deck status words. */
export function statusTitle(status: StatusKey): string {
  return {
    open: "Open offer",
    filled: "Waiting for repayment",
    repaid: "Repaid",
    expired: "Expired",
    liquidated: "Liquidated",
    cancelled: "Cancelled",
  }[status];
}

export function debtOf(offer: Offer): bigint {
  return debt(offer.principal, offer.interestBps);
}

export function computeHealth(
  offer: Offer,
  price: PriceSnapshot,
): { healthBps: number; currentLtvBps: number; valueUsdc: bigint } {
  const valueUsdc = collateralValueUsdc(offer.collateralAmount, price.price, price.conf, price.exponent);
  const ltv = currentLtvBps(debtOf(offer), valueUsdc);
  return { healthBps: healthBps(ltv, offer.liquidationLtvBps), currentLtvBps: ltv, valueUsdc };
}

/** Mirrors liquidate_loan: filled, not expired, fresh price, LTV at or past the line. */
export function canLiquidate(offer: Offer, price: PriceSnapshot | null, chainNow: number): boolean {
  if (offer.status !== "filled" || !price?.fresh || chainNow >= offer.expiryTs) return false;
  return computeHealth(offer, price).currentLtvBps >= offer.liquidationLtvBps;
}

/** The wSOL split exactly as the program computes it. */
export function liquidationFigures(
  offer: Offer,
  price: PriceSnapshot,
): { payUsdc: bigint; receiveWsol: bigint; returnWsol: bigint } {
  const lamports = offer.collateralAmount;
  const valueUsdc = collateralValueUsdc(lamports, price.price, price.conf, price.exponent);
  const owed = debtOf(offer);
  const toCaller = wsolToCaller(lamports, seizeUsdc(owed), valueUsdc);
  return { payUsdc: owed, receiveWsol: toCaller, returnWsol: lamports - toCaller };
}

/** Mirrors accept_offer's LTV check at the current price. */
export function canAcceptAtPrice(offer: Offer, price: PriceSnapshot | null): boolean {
  if (!price?.fresh) return false;
  return computeHealth(offer, price).currentLtvBps <= offer.maxLtvBps;
}
