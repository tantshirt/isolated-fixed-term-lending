"use client";

import { useState } from "react";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Chips } from "@/components/ui/Chips";
import { Slider } from "@/components/ui/Slider";
import { CAPS } from "@/lib/constants";
import { atomsToNumber, fmt, formatDuration } from "@/lib/format";
import type { DraftErrors } from "@/lib/offer-validation";
import type { WizardDraft } from "./useDraft";
import styles from "./CreateWizard.module.css";

const TERMS = [
  { value: 600, label: "10 min" },
  { value: 86_400, label: "1 day" },
  { value: 7 * 86_400, label: "7 days" },
  { value: 30 * 86_400, label: "30 days" },
  { value: 90 * 86_400, label: "90 days" },
];

const UNITS = { minutes: 60, hours: 3_600, days: 86_400 } as const;
type Unit = keyof typeof UNITS;

export function StepTerms({
  draft,
  update,
  errors,
  principal,
  owed,
}: {
  draft: WizardDraft;
  update: (p: Partial<WizardDraft>) => void;
  errors: DraftErrors;
  principal: bigint | null;
  owed: bigint | null;
}) {
  const preset = TERMS.some((t) => t.value === draft.durationSeconds);
  const [custom, setCustom] = useState(!preset);
  const [unit, setUnit] = useState<Unit>(draft.durationSeconds % 86_400 === 0 ? "days" : draft.durationSeconds % 3_600 === 0 ? "hours" : "minutes");
  const amount = Math.round(draft.durationSeconds / UNITS[unit]);
  const interest = principal !== null && owed !== null ? owed - principal : null;
  const yearly = (draft.interestBps / 100) * (31_536_000 / Math.max(60, draft.durationSeconds));

  return (
    <div className={styles.fields}>
      <Slider
        label="Interest for the whole term"
        value={draft.interestBps}
        min={0}
        max={CAPS.maxInterestBps}
        step={25}
        onChange={(v) => update({ interestBps: v })}
        format={(v) => `${(v / 100).toFixed(2)}%`}
        markers={[
          { value: 500, label: "5%" },
          { value: 800, label: "8%" },
          { value: 1200, label: "12%" },
          { value: 2000, label: "20%" },
        ]}
      />
      {errors.interestBps && <p className={styles.fieldError}>{errors.interestBps}</p>}

      <div className={styles.termRow}>
        <Chips
          label="Term"
          options={[...TERMS.map((t) => ({ value: String(t.value), label: t.label })), { value: "custom", label: "Custom" }]}
          value={custom ? "custom" : String(draft.durationSeconds)}
          onChange={(v) => {
            if (v === "custom") return setCustom(true);
            setCustom(false);
            update({ durationSeconds: Number(v) });
          }}
        />
        {custom && (
          <div className={styles.custom}>
            <input
              className={`${styles.customInput} num`}
              inputMode="numeric"
              aria-label="Term length"
              value={Number.isFinite(amount) ? amount : ""}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, "")) || 0;
                update({ durationSeconds: n * UNITS[unit] });
              }}
            />
            <select
              className={styles.customUnit}
              aria-label="Term unit"
              value={unit}
              onChange={(e) => {
                const u = e.target.value as Unit;
                setUnit(u);
                update({ durationSeconds: Math.max(1, amount) * UNITS[u] });
              }}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>
        )}
        {errors.durationSeconds && <p className={styles.fieldError}>{errors.durationSeconds}</p>}
      </div>

      <div className={styles.callout}>
        <p>
          The borrower pays{" "}
          <strong className="num">
            <AnimatedNumber value={interest !== null ? atomsToNumber(interest, 6) : 0} format={fmt.usd} />
          </strong>{" "}
          USDC of interest over {formatDuration(draft.durationSeconds)}, whether they repay on day one or at the last minute.
        </p>
        <p className={styles.calloutSub}>
          That is about <span className="num">{yearly >= 1000 ? "1,000+" : yearly.toFixed(1)}%</span> a year. Interest is fixed
          for the whole term.
        </p>
      </div>
    </div>
  );
}
