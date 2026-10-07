"use client";

import { AmountInput } from "@/components/ui/AmountInput";
import { Chips } from "@/components/ui/Chips";
import { RangeSlider } from "@/components/ui/Slider";
import { CAPS } from "@/lib/constants";
import type { LivePrice } from "@/lib/client/hooks";
import { formatWsol } from "@/lib/format";
import { parseAmount, type DraftErrors } from "@/lib/offer-validation";
import { priceUsd, solPriceAtLtv } from "@/lib/risk";
import { PriceLadder } from "./PriceLadder";
import { CollateralPicker } from "./CollateralPicker";
import { WSOL_ASSET } from "@/lib/models/collateral";
import type { CollateralAsset } from "@/lib/models";
import type { Cushion, Perspective, WizardDraft } from "./useDraft";
import styles from "./CreateWizard.module.css";

const CUSHIONS: { value: string; label: string }[] = [
  { value: "0", label: "Exact minimum" },
  { value: "10", label: "+10%" },
  { value: "25", label: "+25%" },
  { value: "50", label: "+50%" },
  { value: "manual", label: "My own amount" },
];

export function StepRisk({
  draft,
  update,
  errors,
  price,
  owed,
  perspective = "lender",
  asset = WSOL_ASSET,
}: {
  draft: WizardDraft;
  update: (p: Partial<WizardDraft>) => void;
  errors: DraftErrors;
  price: LivePrice | null;
  owed: bigint | null;
  perspective?: Perspective;
  /** The chosen collateral; its decimals, caps and feed drive every figure here (Story 26.2). */
  asset?: CollateralAsset;
}) {
  const borrower = perspective === "borrower";
  const unit = asset.label;
  const lamports = parseAmount(draft.collateral, asset.decimals);
  const acceptBelow = owed && lamports ? solPriceAtLtv(owed, lamports, draft.maxLtvBps) : null;
  const liqBelow = owed && lamports ? solPriceAtLtv(owed, lamports, draft.liquidationLtvBps) : null;
  const now = price ? priceUsd(price) : null;
  const tooThin = acceptBelow !== null && now !== null && acceptBelow > now;

  return (
    <div className={styles.fields}>
      <CollateralPicker draft={draft} asset={asset} update={update} label={borrower ? "Collateral you lock" : "Collateral the borrower locks"} />
      {errors.collateralMint && <p className={styles.fieldError}>{errors.collateralMint}</p>}
      <RangeSlider
        label="Loan-to-value limits"
        low={draft.maxLtvBps}
        high={draft.liquidationLtvBps}
        min={3_000}
        max={9_000}
        step={50}
        minGap={CAPS.minLtvGapBps}
        lowMax={Math.min(CAPS.maxLtvBps, asset.maxLtvBps)}
        highMax={Math.min(CAPS.maxLiquidationLtvBps, asset.liquidationLtvBps)}
        lowLabel="Max LTV to borrow"
        highLabel="Liquidation LTV"
        format={(v) => `${(v / 100).toFixed(1)}%`}
        onChange={(low, high) => update({ maxLtvBps: low, liquidationLtvBps: high })}
      />
      {(errors.maxLtvBps || errors.liquidationLtvBps) && (
        <p className={styles.fieldError}>{errors.maxLtvBps ?? errors.liquidationLtvBps}</p>
      )}

      <Chips
        label={borrower ? `${unit} you lock` : `${unit} the borrower locks`}
        options={CUSHIONS}
        value={draft.collateralMode === "manual" ? "manual" : String(draft.cushion)}
        onChange={(v) =>
          v === "manual"
            ? update({ collateralMode: "manual", collateral: draft.collateral })
            : update({ collateralMode: "auto", cushion: Number(v) as Cushion })
        }
      />

      {draft.collateralMode === "manual" ? (
        <AmountInput
          label="Collateral"
          unit={asset.symbol}
          decimals={asset.decimals}
          value={draft.collateral}
          onChange={(v) => update({ collateral: v })}
          error={errors.collateral}
          autoFocus
        />
      ) : (
        <p className={styles.collateralReadout}>
          <span className={`${styles.collateralBig} num`}>{lamports ? formatWsol(lamports) : "—"}</span> {unit}
          <span className={styles.collateralSub}>
            {draft.cushion === 0
              ? `The least ${unit} that meets your max LTV at today's price.`
              : `The minimum at today's price, plus ${draft.cushion}% so a small dip does not block ${borrower ? "funding" : "the borrower"}.`}
          </span>
        </p>
      )}

      {now !== null && acceptBelow !== null && liqBelow !== null ? (
        <PriceLadder priceName={asset.symbol === "wSOL" ? "SOL" : asset.symbol} now={now} acceptBelow={acceptBelow} liquidateBelow={liqBelow} acceptLabel={borrower ? "Lenders can fund above" : undefined} />
      ) : (
        <p className={styles.explain}>Waiting for the {asset.symbol === "wSOL" ? "SOL" : asset.symbol} price…</p>
      )}

      {tooThin && (
        <p className={styles.warn}>
          At today&apos;s price this collateral is already past your max LTV, so{" "}
          {borrower ? "no lender could fund the request" : "no borrower could take the offer"}. Add {unit} or raise the max LTV.
        </p>
      )}
    </div>
  );
}
