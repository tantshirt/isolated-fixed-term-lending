import Link from "next/link";
import { formatBpsAsPercent, formatDuration, formatUsdc, formatWsol } from "@/lib/format";
import { debt } from "@/lib/loan-math";
import { computeHealth, type PriceSnapshot } from "@/lib/offer-status";
import { requestAsOffer, requestHref, type LoanRequest } from "@/lib/requests";
import { RequestStatusPill } from "./RequestStatusPill";
import styles from "@/components/offers/OfferRow.module.css";

/** One public borrower request. Same columns as an offer row, from the borrower's side. */
export function RequestRow({
  request: r,
  price,
  me = null,
}: {
  request: LoanRequest;
  price: PriceSnapshot | null;
  /** The connected wallet, so open requests from others offer "Fund". */
  me?: string | null;
}) {
  const fundable = r.status === "open" && !!me && r.borrower !== me;
  const yours = !!me && r.borrower === me;
  const owed = debt(r.principal, r.interestBps);
  const ltv = price ? computeHealth(requestAsOffer(r), price).currentLtvBps : null;
  return (
    <Link href={requestHref(r)} className={styles.row}>
      <span className={styles.principal}>
        <span className={`${styles.big} num`}>{formatUsdc(r.principal)}</span>
        <span className={styles.unit}>USDC</span>
      </span>
      <span className={styles.cell} data-label="Repays">
        <span className="num">{formatUsdc(owed)}</span>
        <span className={styles.sub}>{formatBpsAsPercent(r.interestBps)} for the term</span>
      </span>
      <span className={styles.cell} data-label="Term">
        <span>{formatDuration(r.durationSeconds)}</span>
        <span className={styles.sub}>Max LTV {formatBpsAsPercent(r.maxLtvBps, 0)}</span>
      </span>
      <span className={styles.cell} data-label="Collateral locked">
        <span className="num">{formatWsol(r.collateralAmount)} wSOL</span>
        <span className={styles.sub}>
          {ltv === null ? `Liquidates at ${formatBpsAsPercent(r.liquidationLtvBps, 0)}` : `LTV today ${formatBpsAsPercent(ltv, 0)}`}
        </span>
      </span>
      <span className={styles.status}>
        {fundable ? <span className={styles.fund}>Fund this request</span> : yours ? <span className={styles.yours}>Your request</span> : <RequestStatusPill status={r.status} />}
        <svg className={styles.chevron} width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.75" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </Link>
  );
}
