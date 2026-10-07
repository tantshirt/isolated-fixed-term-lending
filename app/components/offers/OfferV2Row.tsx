import Link from "next/link";
import { HealthPill } from "@/components/ui/StatusPill";
import { formatBpsAsPercent, formatDuration, formatUsdc, formatWsol } from "@/lib/format";
import { EarlyRepayment, fullTermInterest } from "@/lib/loan-math-v2";
import { v2LoanView } from "@/lib/models/loan-view";
import type { PriceSnapshot } from "@/lib/offer-status";
import { offerV2Href, type OfferV2 } from "@/lib/v2/offers";
import styles from "./OfferRow.module.css";

const WORDS: Record<OfferV2["status"], string> = {
  open: "Open offer",
  active: "Waiting for repayment",
  repaid: "Repaid",
  liquidated: "Liquidated",
  overdueLiquidated: "Settled after grace",
  pricedRecovered: "Recovered",
  terminalClaimed: "Collateral claimed",
  cancelled: "Cancelled",
};

/** A repayment-rules (V2) offer in the same row layout as V1 offers. */
export function OfferV2Row({ offer: o, price, now }: { offer: OfferV2; price: PriceSnapshot | null; now: number | null }) {
  const t = o.terms;
  const view = o.status === "active" && now !== null ? v2LoanView(o, price, now) : null;
  return (
    <Link href={offerV2Href(o)} className={styles.row}>
      <span className={styles.principal}>
        <span className={`${styles.big} num`}>{formatUsdc(t.principal)}</span>
        <span className={styles.unit}>USDC</span>
      </span>
      <span className={styles.cell} data-label="Repay">
        <span className="num">{formatUsdc(t.principal + fullTermInterest(t))}</span>
        <span className={styles.sub}>{t.earlyRepayment === EarlyRepayment.ProRata ? "Less if repaid early" : `${formatBpsAsPercent(t.interestBps)} for the term`}</span>
      </span>
      <span className={styles.cell} data-label="Term">
        <span>{formatDuration(t.duration)}</span>
        <span className={styles.sub}>+ {formatDuration(t.graceSeconds)} grace</span>
      </span>
      <span className={styles.cell} data-label="Collateral">
        <span className="num">{formatWsol(o.status === "open" ? o.collateralRequired : o.collateralLocked)} wSOL</span>
        <span className={styles.sub}>Liquidates at {formatBpsAsPercent(o.liquidationLtvBps, 0)}</span>
      </span>
      <span className={styles.status}>
        {view?.risk ? <HealthPill healthBps={view.risk.healthBps} /> : <span className={styles.sub}>{WORDS[o.status]}</span>}
      </span>
    </Link>
  );
}
