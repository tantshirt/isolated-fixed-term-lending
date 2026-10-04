import { CAPS } from "./constants";
import { debt } from "./loan-math";

/** What the create wizard collects, as the user typed it. */
export type OfferDraft = {
  principal: string; // USDC, e.g. "100" or "100.5"
  interestBps: number;
  durationSeconds: number;
  collateral: string; // wSOL, e.g. "1.25"
  maxLtvBps: number;
  liquidationLtvBps: number;
};

export type ParsedOffer = {
  principal: bigint;
  interestBps: number;
  durationSeconds: number;
  collateralAmount: bigint;
  maxLtvBps: number;
  liquidationLtvBps: number;
  debt: bigint;
};

export type DraftErrors = Partial<Record<keyof OfferDraft, string>>;

const DECIMAL = /^\d+(\.\d*)?$|^\.\d+$/;

/** Parses a decimal string into atoms. Returns null for anything that is not a plain positive decimal. */
export function parseAmount(value: string, decimals: number): bigint | null {
  const trimmed = value.trim().replace(/,/g, "");
  if (!trimmed || !DECIMAL.test(trimmed)) return null;
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function validateAmountStep(draft: Pick<OfferDraft, "principal">): DraftErrors {
  const principal = parseAmount(draft.principal, 6);
  if (principal === null) return { principal: "Enter an amount, up to 6 decimals." };
  if (principal === 0n) return { principal: "Lend more than zero." };
  return {};
}

export function validateTermsStep(
  draft: Pick<OfferDraft, "interestBps" | "durationSeconds">,
): DraftErrors {
  const errors: DraftErrors = {};
  if (!Number.isInteger(draft.interestBps) || draft.interestBps < 0 || draft.interestBps > CAPS.maxInterestBps) {
    errors.interestBps = `Interest runs from 0% to ${CAPS.maxInterestBps / 100}%.`;
  }
  if (
    !Number.isInteger(draft.durationSeconds) ||
    draft.durationSeconds < CAPS.minDurationSeconds ||
    draft.durationSeconds > CAPS.maxDurationSeconds
  ) {
    errors.durationSeconds = "The term runs from 1 minute to 90 days.";
  }
  return errors;
}

export function validateRiskStep(
  draft: Pick<OfferDraft, "collateral" | "maxLtvBps" | "liquidationLtvBps">,
): DraftErrors {
  const errors: DraftErrors = {};
  const collateral = parseAmount(draft.collateral, 9);
  if (collateral === null) errors.collateral = "Enter a wSOL amount, up to 9 decimals.";
  else if (collateral === 0n) errors.collateral = "Ask for more than zero wSOL.";

  if (!Number.isInteger(draft.maxLtvBps) || draft.maxLtvBps <= 0 || draft.maxLtvBps > CAPS.maxLtvBps) {
    errors.maxLtvBps = `Max LTV is at most ${CAPS.maxLtvBps / 100}%.`;
  }
  if (
    !Number.isInteger(draft.liquidationLtvBps) ||
    draft.liquidationLtvBps > CAPS.maxLiquidationLtvBps ||
    draft.liquidationLtvBps < draft.maxLtvBps + CAPS.minLtvGapBps
  ) {
    errors.liquidationLtvBps = `Liquidation LTV sits at least ${CAPS.minLtvGapBps / 100} points above max LTV, and at most ${CAPS.maxLiquidationLtvBps / 100}%.`;
  }
  return errors;
}

export function validateDraft(draft: OfferDraft): DraftErrors {
  return { ...validateAmountStep(draft), ...validateTermsStep(draft), ...validateRiskStep(draft) };
}

/** Returns the on-chain arguments, or null when any step is invalid. */
export function parseDraft(draft: OfferDraft): ParsedOffer | null {
  if (Object.keys(validateDraft(draft)).length > 0) return null;
  const principal = parseAmount(draft.principal, 6)!;
  return {
    principal,
    interestBps: draft.interestBps,
    durationSeconds: draft.durationSeconds,
    collateralAmount: parseAmount(draft.collateral, 9)!,
    maxLtvBps: draft.maxLtvBps,
    liquidationLtvBps: draft.liquidationLtvBps,
    debt: debt(principal, draft.interestBps),
  };
}
