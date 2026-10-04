"use client";

import { useChainNow, type LivePrice } from "@/lib/client/hooks";
import { formatBpsAsPercent, formatDeadline, formatDuration, formatUsdc, formatWsol } from "@/lib/format";
import { parseAmount } from "@/lib/offer-validation";
import type { WizardDraft } from "./useDraft";
import styles from "./CreateWizard.module.css";

export function StepReview({
  draft,
  owed,
  price,
  onEdit,
}: {
  draft: WizardDraft;
  owed: bigint | null;
  price: LivePrice | null;
  onEdit: (step: number) => void;
}) {
  const now = useChainNow(price);
  const principal = parseAmount(draft.principal, 6) ?? 0n;
  const lamports = parseAmount(draft.collateral, 9) ?? 0n;
  const rows: { label: string; value: string; step: number }[] = [
    { label: "You lend", value: `${formatUsdc(principal)} USDC`, step: 1 },
    { label: "Interest for the whole term", value: formatBpsAsPercent(draft.interestBps, 2), step: 2 },
    { label: "Term", value: formatDuration(draft.durationSeconds), step: 2 },
    { label: "wSOL required", value: `${formatWsol(lamports)} wSOL`, step: 3 },
    { label: "Max LTV", value: formatBpsAsPercent(draft.maxLtvBps), step: 3 },
    { label: "Liquidation LTV", value: formatBpsAsPercent(draft.liquidationLtvBps), step: 3 },
  ];

  return (
    <div className={styles.fields}>
      <p className={styles.sentence}>
        You lend <b className="num">{formatUsdc(principal)}</b> USDC. A borrower locks{" "}
        <b className="num">{formatWsol(lamports)}</b> wSOL and owes you <b className="num">{owed ? formatUsdc(owed) : "—"}</b> USDC
        within {formatDuration(draft.durationSeconds)}. Taken now, the last second to repay would be{" "}
        <b>{formatDeadline(now + draft.durationSeconds)}</b>.
      </p>
      <p className={styles.sentenceStrong}>If they miss that time, you receive the wSOL.</p>

      <dl className={styles.terms}>
        {rows.map((r) => (
          <div key={r.label} className={styles.termRowItem}>
            <dt>{r.label}</dt>
            <dd className="num">{r.value}</dd>
            <button type="button" className={styles.edit} onClick={() => onEdit(r.step)} aria-label={`Edit ${r.label}`}>
              Edit
            </button>
          </div>
        ))}
      </dl>
    </div>
  );
}
