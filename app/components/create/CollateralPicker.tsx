"use client";

import { Chips } from "@/components/ui/Chips";
import { selectableCollateral, switchCollateral } from "@/lib/models/collateral";
import type { CollateralAsset } from "@/lib/models";
import { V2_LIVE } from "@/lib/v2/program";
import type { WizardDraft } from "./useDraft";

/**
 * wSOL or jitoSOL (test) for a public V2 offer or request (Story 26.2). Renders nothing unless this
 * deployment enables a second asset, so with the flag off the wizard reads exactly as before.
 */
export function CollateralPicker({
  draft,
  asset,
  update,
  label,
}: {
  draft: WizardDraft;
  asset: CollateralAsset;
  update: (p: Partial<WizardDraft>) => void;
  label: string;
}) {
  const assets = V2_LIVE ? selectableCollateral() : [];
  if (assets.length < 2) return null;
  return (
    <Chips
      label={label}
      options={assets.map((a) => ({ value: a.mint, label: a.label }))}
      value={asset.mint}
      onChange={(mint) => {
        const next = assets.find((a) => a.mint === mint);
        if (next) update(switchCollateral(draft, next));
      }}
    />
  );
}
