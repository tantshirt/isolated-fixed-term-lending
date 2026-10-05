"use client";

import { useEffect, useMemo, useState } from "react";
import type { LivePrice } from "@/lib/client/hooks";
import { debt } from "@/lib/loan-math";
import { parseAmount, type OfferDraft } from "@/lib/offer-validation";
import { validStoredDraft } from "@/lib/simulation";
import { minCollateralLamports } from "@/lib/risk";

export type Cushion = 0 | 10 | 25 | 50;

export type WizardDraft = OfferDraft & {
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
};

const KEY = "lendspan-devnet-create-draft-v1";

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
 * rounded up to 4 decimals so it reads cleanly.
 */
export function useDraft(price: LivePrice | null) {
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
          setDraft(value.draft as WizardDraft);
      }
    } catch {}
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ version: 1, draft }));
    } catch {}
  }, [draft, hydrated]);

  const principal = parseAmount(draft.principal, 6);
  const owed =
    principal !== null &&
    Number.isInteger(draft.interestBps) &&
    draft.interestBps >= 0
      ? debt(principal, draft.interestBps)
      : null;

  const autoCollateral = useMemo(() => {
    if (
      !price ||
      owed === null ||
      owed === 0n ||
      !Number.isInteger(draft.maxLtvBps) ||
      draft.maxLtvBps <= 0
    )
      return null;
    const min = minCollateralLamports(owed, draft.maxLtvBps, price);
    const cushioned = (min * BigInt(100 + draft.cushion) + 99n) / 100n;
    const step = 100_000n; // 0.0001 wSOL
    return ((cushioned + step - 1n) / step) * step;
  }, [price, owed, draft.maxLtvBps, draft.cushion]);

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

  return { draft: effective, update, reset, owed, principal, hydrated };
}
