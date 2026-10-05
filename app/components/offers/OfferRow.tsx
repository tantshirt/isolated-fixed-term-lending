import Link from "next/link";
import { HealthPill, StatusPill } from "@/components/ui/StatusPill";
import {
  formatBpsAsPercent,
  formatDuration,
  formatUsdc,
  formatWsol,
} from "@/lib/format";
import { debt } from "@/lib/loan-math";
import { computeHealth, type PriceSnapshot } from "@/lib/offer-status";
import type { Offer } from "@/lib/offers";
import styles from "./OfferRow.module.css";

export function offerHref(o: Offer) {
  return `/devnet/offers/${o.lender}/${o.offerId.toString()}`;
}

export function OfferRow({
  offer: o,
  price,
}: {
  offer: Offer;
  price: PriceSnapshot | null;
}) {
  const owed = debt(o.principal, o.interestBps);
  const health =
    o.status === "filled" && price ? computeHealth(o, price).healthBps : null;
  return (
    <Link href={offerHref(o)} className={styles.row}>
      <span className={styles.principal}>
        <span className={`${styles.big} num`}>{formatUsdc(o.principal)}</span>
        <span className={styles.unit}>USDC</span>
      </span>
      <span className={styles.cell} data-label="Repay">
        <span className="num">{formatUsdc(owed)}</span>
        <span className={styles.sub}>
          {formatBpsAsPercent(o.interestBps)} for the term
        </span>
      </span>
      <span className={styles.cell} data-label="Term">
        <span>{formatDuration(o.durationSeconds)}</span>
        <span className={styles.sub}>
          Max LTV {formatBpsAsPercent(o.maxLtvBps, 0)}
        </span>
      </span>
      <span className={styles.cell} data-label="Collateral">
        <span className="num">{formatWsol(o.collateralAmount)} wSOL</span>
        <span className={styles.sub}>
          Liquidates at {formatBpsAsPercent(o.liquidationLtvBps, 0)}
        </span>
      </span>
      <span className={styles.status}>
        {health !== null ? (
          <HealthPill healthBps={health} />
        ) : (
          <StatusPill status={o.status} />
        )}
        <svg
          className={styles.chevron}
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden
        >
          <path
            d="M6 3.5L10.5 8 6 12.5"
            stroke="currentColor"
            strokeWidth="1.75"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </Link>
  );
}
