"use client";

import { useEffect, useMemo, useState } from "react";
import { useCollateralPrice } from "@/lib/client/collateral-price";
import { debt } from "@/lib/loan-math";
import { parseAmount, type OfferDraft } from "@/lib/offer-validation";
import { validStoredDraft } from "@/lib/simulation";
import { minCollateralLamports } from "@/lib/risk";
import { maxExposure } from "@/lib/loan-math-v2";
import { V2_LIVE } from "@/lib/v2/program";
import { WSOL_ASSET, draftCollateral } from "@/lib/models/collateral";
import { DEFAULT_RULES, readRules, termsFrom, type RepaymentRules } from "@/lib/v2/rules";

export type Cushion = 0 | 10 | 25 | 50;

/** Who is filling in the terms. Lenders create offers; borrowers post requests. */
export type Perspective = "lender" | "borrower";

export type WizardDraft = OfferDraft & {
  rules: RepaymentRules;
  /** "auto" derives collateral from max LTV, the live price and the cushion. */
  collateralMode: "auto" | "manual";
  cushion: Cushion;
};

export const DEFAULT_DRAFT: WizardDraft = {
  principal: "100",
  interestBps: 500,
  durationSeconds: 7 * 86_400,
  collateral: "",
  maxLtvBps: 7_000,
  liquidationLtvBps: 8_000,
  collateralMode: "auto",
  cushion: 10,
  rules: DEFAULT_RULES,
};

const CREATE_KEY = "lendspan-devnet-create-draft-v1";

function lamportsToString(l: bigint): string {
  const whole = l / 1_000_000_000n;
  const frac = (l % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Draft survives a refresh within the session. In auto mode the collateral is the
 * minimum that meets max LTV at the live price, plus a cushion against a falling price,
 * rounded up to 4 decimals so it reads cleanly. The price is the chosen collateral's own feed
 * (Story 26.2): SOL/USD for wSOL, JITOSOL/USD for jitoSOL (test).
 */
export function useDraft(KEY = CREATE_KEY) {
  const [draft, setDraft] = useState<WizardDraft>(DEFAULT_DRAFT);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(KEY);
      if (raw) {
        const value = JSON.parse(raw);
        const d = value.draft;
        if (
          value.version === 1 &&
          validStoredDraft(d) &&
          ["auto", "manual"].includes(value.draft.collateralMode) &&
          [0, 10, 25, 50].includes(value.draft.cushion)
        )
          setDraft({
            ...DEFAULT_DRAFT,
            ...(value.draft as WizardDraft),
            rules: readRules(value.draft.rules),
            // A saved asset this deployment no longer enables falls back to wSOL.
            collateralMint: draftCollateral(value.draft.collateralMint) && V2_LIVE ? value.draft.collateralMint : undefined,
          });
      }
    } catch {}
    setHydrated(true);
  }, [KEY]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ version: 1, draft }));
    } catch {}
  }, [draft, hydrated, KEY]);

  const asset = (V2_LIVE && draftCollateral(draft.collateralMint)) || WSOL_ASSET;
  const { price } = useCollateralPrice(asset);
  const principal = parseAmount(draft.principal, 6);
  const owed =
    principal !== null &&
    Number.isInteger(draft.interestBps) &&
    draft.interestBps >= 0
      ? debt(principal, draft.interestBps)
      : null;

  // V2 checks origination LTV against the maximum contractual exposure (interest plus late fee
  // within the ceiling), so the suggested collateral covers that, not just principal plus interest.
  const terms =
    V2_LIVE && principal !== null && principal > 0n
      ? termsFrom({ principal, interestBps: draft.interestBps, durationSeconds: draft.durationSeconds }, draft.rules)
      : null;
  const exposure = terms ? maxExposure(terms) : owed;

  const autoCollateral = useMemo(() => {
    if (
      !price ||
      exposure === null ||
      exposure === 0n ||
      !Number.isInteger(draft.maxLtvBps) ||
      draft.maxLtvBps <= 0
    )
      return null;
    const min = minCollateralLamports(exposure, draft.maxLtvBps, price);
    const cushioned = (min * BigInt(100 + draft.cushion) + 99n) / 100n;
    const step = 100_000n; // 0.0001 wSOL
    return ((cushioned + step - 1n) / step) * step;
  }, [price, exposure, draft.maxLtvBps, draft.cushion]);

  const collateral =
    draft.collateralMode === "auto" && autoCollateral !== null
      ? lamportsToString(autoCollateral)
      : draft.collateral;

  const effective: WizardDraft = { ...draft, collateral };

  const update = (patch: Partial<WizardDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const reset = () => {
    setDraft(DEFAULT_DRAFT);
    try {
      sessionStorage.removeItem(KEY);
    } catch {}
  };

  return { draft: effective, update, reset, owed, principal, hydrated, terms, exposure, asset, price };
}
