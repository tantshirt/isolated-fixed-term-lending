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
import type { Cushion, WizardDraft } from "./useDraft";
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
}: {
  draft: WizardDraft;
  update: (p: Partial<WizardDraft>) => void;
  errors: DraftErrors;
  price: LivePrice | null;
  owed: bigint | null;
}) {
  const lamports = parseAmount(draft.collateral, 9);
  const acceptBelow = owed && lamports ? solPriceAtLtv(owed, lamports, draft.maxLtvBps) : null;
  const liqBelow = owed && lamports ? solPriceAtLtv(owed, lamports, draft.liquidationLtvBps) : null;
  const now = price ? priceUsd(price) : null;
  const tooThin = acceptBelow !== null && now !== null && acceptBelow > now;

  return (
    <div className={styles.fields}>
      <RangeSlider
        label="Loan-to-value limits"
        low={draft.maxLtvBps}
        high={draft.liquidationLtvBps}
        min={3_000}
        max={9_000}
        step={50}
        minGap={CAPS.minLtvGapBps}
        lowMax={CAPS.maxLtvBps}
        highMax={CAPS.maxLiquidationLtvBps}
        lowLabel="Max LTV to borrow"
        highLabel="Liquidation LTV"
        format={(v) => `${(v / 100).toFixed(1)}%`}
        onChange={(low, high) => update({ maxLtvBps: low, liquidationLtvBps: high })}
      />
      {(errors.maxLtvBps || errors.liquidationLtvBps) && (
        <p className={styles.fieldError}>{errors.maxLtvBps ?? errors.liquidationLtvBps}</p>
      )}

      <Chips
        label="wSOL the borrower locks"
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
          unit="wSOL"
          decimals={9}
          value={draft.collateral}
          onChange={(v) => update({ collateral: v })}
          error={errors.collateral}
          autoFocus
        />
      ) : (
        <p className={styles.collateralReadout}>
          <span className={`${styles.collateralBig} num`}>{lamports ? formatWsol(lamports) : "—"}</span> wSOL
          <span className={styles.collateralSub}>
            {draft.cushion === 0
              ? "The least wSOL that meets your max LTV at today's price."
              : `The minimum at today's price, plus ${draft.cushion}% so a small dip does not block the borrower.`}
          </span>
        </p>
      )}

      {now !== null && acceptBelow !== null && liqBelow !== null ? (
        <PriceLadder now={now} acceptBelow={acceptBelow} liquidateBelow={liqBelow} />
      ) : (
        <p className={styles.explain}>Waiting for the SOL price…</p>
      )}

      {tooThin && (
        <p className={styles.warn}>
          At today&apos;s price this collateral is already past your max LTV, so no borrower could take the offer. Add wSOL or
          raise the max LTV.
        </p>
      )}
    </div>
  );
}
