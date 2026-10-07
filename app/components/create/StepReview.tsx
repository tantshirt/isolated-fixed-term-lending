"use client";

import { useChainNow, type LivePrice } from "@/lib/client/hooks";
import {
  formatBpsAsPercent,
  formatDeadline,
  formatDuration,
  formatUsdc,
  formatWsol,
} from "@/lib/format";
import { parseAmount } from "@/lib/offer-validation";
import { RESALE_NOTICE } from "@/lib/v2/market";
import { V2_LIVE } from "@/lib/v2/program";
import { reviewFigures, termsFrom } from "@/lib/v2/rules";
import type { Perspective, WizardDraft } from "./useDraft";
import styles from "./CreateWizard.module.css";

export function StepReview({
  draft,
  owed,
  onEdit,
  perspective = "lender",
}: {
  draft: WizardDraft;
  owed: bigint | null;
  price: LivePrice | null;
  onEdit: (step: number) => void;
  perspective?: Perspective;
}) {
  const borrower = perspective === "borrower";
  const now = useChainNow();
  const principal = parseAmount(draft.principal, 6) ?? 0n;
  const lamports = parseAmount(draft.collateral, 9) ?? 0n;
  const rows: { label: string; value: string; step: number }[] = [
    { label: borrower ? "You borrow" : "You lend", value: `${formatUsdc(principal)} USDC`, step: 1 },
    {
      label: "Interest for the whole term",
      value: formatBpsAsPercent(draft.interestBps, 2),
      step: 2,
    },
    { label: "Term", value: formatDuration(draft.durationSeconds), step: 2 },
    { label: borrower ? "wSOL you lock" : "wSOL required", value: `${formatWsol(lamports)} wSOL`, step: 3 },
    { label: "Max LTV", value: formatBpsAsPercent(draft.maxLtvBps), step: 3 },
    {
      label: "Liquidation LTV",
      value: formatBpsAsPercent(draft.liquidationLtvBps),
      step: 3,
    },
  ];

  const terms = V2_LIVE && principal > 0n ? termsFrom({ principal, interestBps: draft.interestBps, durationSeconds: draft.durationSeconds }, draft.rules) : null;
  if (terms) {
    const f = reviewFigures(terms, now ?? 0);
    const when = (t: number) => (now === null ? "after the chain clock reconnects" : formatDeadline(t));
    const proRata = draft.rules.earlyRepayment === "pro-rata";
    const v2rows: { label: string; value: string; step: number }[] = [
      ...rows.slice(0, 3),
      { label: "Early repayment", value: proRata ? `Interest for time used, minimum ${formatUsdc(f.minInterest)} USDC` : "Full-term interest", step: 2 },
      { label: "Term cost", value: `${formatUsdc(f.termCost)} USDC`, step: 2 },
      { label: "Annualized pricing", value: `${formatBpsAsPercent(f.annualizedBps, 1)} on a 365-day year`, step: 2 },
      { label: "Annual pricing ceiling", value: `${formatBpsAsPercent(f.ceilingBps, 0)} (at most ${formatUsdc(f.chargeCeiling)} USDC of charges)`, step: 2 },
      { label: "Grace", value: formatDuration(terms.graceSeconds), step: 2 },
      { label: "Late fee", value: `${formatBpsAsPercent(terms.lateFeeBps, 2)} of unpaid principal, up to ${formatUsdc(f.lateFeeMax)} USDC`, step: 2 },
      ...rows.slice(3),
    ];
    return (
      <div className={styles.fields}>
        <p className={styles.sentence}>
          {borrower ? "You lock " : "A borrower locks "}
          <b className="num">{formatWsol(lamports)}</b> wSOL for <b className="num">{formatUsdc(principal)}</b> USDC.{" "}
          {proRata ? (
            <>
              Repaid at the deadline, {borrower ? "you owe" : "they owe"} <b className="num">{owed ? formatUsdc(owed) : "—"}</b> USDC; repaid
              earlier, less, but never under <b className="num">{formatUsdc(terms.principal + f.minInterest)}</b> USDC.
            </>
          ) : (
            <>
              {borrower ? "You owe" : "They owe"} <b className="num">{owed ? formatUsdc(owed) : "—"}</b> USDC whenever the loan is repaid.
            </>
          )}{" "}
          Partial payments go to interest, then any late fee, then principal, and never move the deadline.
        </p>
        <ol className={styles.timeline} aria-label={borrower ? "If funded now" : "If taken now"}>
          <li>
            <span>Deadline</span>
            <span>{when(f.maturity)}. From here a one-time late fee applies.</span>
          </li>
          <li>
            <span>Grace ends</span>
            <span>{when(f.graceEnd)}. Anyone may then pay what is owed and take wSOL worth that plus 5%; the rest returns to the borrower.</span>
          </li>
          <li>
            <span>Priced recovery</span>
            <span>{when(f.pricedRecoveryFrom)}. The lender may take wSOL worth what is owed, with no bonus; the rest returns to the borrower.</span>
          </li>
          <li>
            <span>Final claim</span>
            <span>{when(f.terminalClaimFrom)}. The lender may take all remaining wSOL without a price, even if it is worth more than the debt.</span>
          </li>
        </ol>
        <p className={styles.sentenceStrong}>
          {borrower
            ? "Repay any time before a settlement executes and you keep all your wSOL. After the final claim time, you can lose any surplus."
            : "The borrower can repay until a settlement executes. After the final claim time, you may take all of the wSOL."}
        </p>
        <p className={styles.sentence}>
          The price can fall before the deadline too: if the liquidation LTV is crossed on both the live and the average price, or the
          live price runs three points past it, a liquidator can settle early. wSOL is SOL wrapped in a token account.
        </p>
        <p className={styles.sentence}>{borrower ? RESALE_NOTICE : "Once the loan starts you may sell this position. Payments then go to the new holder; the borrower's terms do not change."}</p>
        <dl className={styles.terms}>
          {v2rows.map((r) => (
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

  return (
    <div className={styles.fields}>
      <p className={styles.sentence}>
        {borrower ? (
          <>
            You lock <b className="num">{formatWsol(lamports)}</b> wSOL and ask
            for <b className="num">{formatUsdc(principal)}</b> USDC. When a
            lender funds it, the USDC arrives at once and you owe{" "}
            <b className="num">{owed ? formatUsdc(owed) : "—"}</b> USDC within{" "}
            {formatDuration(draft.durationSeconds)}. Funded now, the last second
            to repay would be{" "}
          </>
        ) : (
          <>
            You lend <b className="num">{formatUsdc(principal)}</b> USDC. A
            borrower locks <b className="num">{formatWsol(lamports)}</b> wSOL
            and owes you{" "}
            <b className="num">{owed ? formatUsdc(owed) : "—"}</b> USDC within{" "}
            {formatDuration(draft.durationSeconds)}. Taken now, the last second
            to repay would be{" "}
          </>
        )}
        <b>
          {now === null
            ? "unknown until the chain clock reconnects"
            : formatDeadline(now + draft.durationSeconds)}
        </b>
        .
      </p>
      <p className={styles.sentence}>
        Early repayment still includes all full-term interest. wSOL is SOL
        wrapped in a token account. Its price can fall; a liquidator can settle
        before the deadline if the liquidation LTV is reached.
      </p>
      <p className={styles.sentenceStrong}>
        {borrower
          ? "If you miss that time, the lender receives your wSOL."
          : "If they miss that time, you receive the wSOL."}
      </p>

      <dl className={styles.terms}>
        {rows.map((r) => (
          <div key={r.label} className={styles.termRowItem}>
            <dt>{r.label}</dt>
            <dd className="num">{r.value}</dd>
            <button
              type="button"
              className={styles.edit}
              onClick={() => onEdit(r.step)}
              aria-label={`Edit ${r.label}`}
            >
              Edit
            </button>
          </div>
        ))}
      </dl>
    </div>
  );
}
