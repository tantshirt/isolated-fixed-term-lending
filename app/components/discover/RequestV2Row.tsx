import Link from "next/link";
import { formatBpsAsPercent, formatDuration, formatUsdc, formatWsol } from "@/lib/format";
import { EarlyRepayment, fullTermInterest } from "@/lib/loan-math-v2";
import { requestV2Href, type RequestV2 } from "@/lib/v2/offers";
import styles from "@/components/offers/OfferRow.module.css";

/** An open V2 borrower request, in the offer row layout. */
export function RequestV2Row({ request: r }: { request: RequestV2 }) {
  const t = r.terms;
  return (
    <Link href={requestV2Href(r)} className={styles.row}>
      <span className={styles.principal}>
        <span className={`${styles.big} num`}>{formatUsdc(t.principal)}</span>
        <span className={styles.unit}>USDC</span>
      </span>
      <span className={styles.cell} data-label="Repays">
        <span className="num">{formatUsdc(t.principal + fullTermInterest(t))}</span>
        <span className={styles.sub}>{t.earlyRepayment === EarlyRepayment.ProRata ? "Less if repaid early" : `${formatBpsAsPercent(t.interestBps)} for the term`}</span>
      </span>
      <span className={styles.cell} data-label="Term">
        <span>{formatDuration(t.duration)}</span>
        <span className={styles.sub}>+ {formatDuration(t.graceSeconds)} grace</span>
      </span>
      <span className={styles.cell} data-label="Collateral locked">
        <span className="num">{formatWsol(r.collateralAmount)} wSOL</span>
        <span className={styles.sub}>Max LTV {formatBpsAsPercent(r.maxLtvBps, 0)}</span>
      </span>
      <span className={styles.status}>
        <span className={styles.sub}>Open</span>
      </span>
    </Link>
  );
}
