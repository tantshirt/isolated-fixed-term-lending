"use client";

import { m } from "motion/react";
import { healthTone } from "@/components/ui/StatusPill";
import { formatBpsAsPercent } from "@/lib/format";
import styles from "./HealthMeter.module.css";

/**
 * Current LTV on a track that ends past the liquidation line. The brass mark is the
 * max LTV a borrower could open at; the red mark is where liquidation opens.
 */
export function HealthMeter({
  ltvBps,
  healthBps,
  maxLtvBps,
  liquidationLtvBps,
  stale,
  maxLabel = "Max LTV at accept",
  liquidationPrice,
  solPrice,
}: {
  ltvBps: number;
  healthBps: number;
  maxLtvBps: number;
  liquidationLtvBps: number;
  stale: boolean;
  /** Words for the max LTV marker; offers check it at accept, requests at funding. */
  maxLabel?: string;
  liquidationPrice: number | null;
  solPrice: number | null;
}) {
  const end = Math.max(liquidationLtvBps * 1.18, 10_000);
  const pos = (v: number) => `${Math.min(100, (v / end) * 100)}%`;
  const tone = healthTone(healthBps);
  const word = tone === "good" ? "Healthy" : tone === "watch" ? "Near the line" : "Past the line";

  return (
    <div className={styles.meter} data-tone={tone}>
      <div className={styles.head}>
        <div>
          <p className={styles.label}>Loan health</p>
          <p className={styles.value}>
            <span className="num">{formatBpsAsPercent(healthBps)}</span>
            <span className={styles.word}>{word}</span>
          </p>
        </div>
        <div className={styles.right}>
          <p className={styles.label}>LTV now</p>
          <p className={`${styles.ltv} num`}>{ltvBps >= 65_535 ? "≥ 655%" : formatBpsAsPercent(ltvBps)}</p>
        </div>
      </div>
      <div className={styles.track}>
        <m.span
          className={styles.fill}
          initial={false}
          animate={{ width: pos(ltvBps) }}
          transition={{ type: "spring", stiffness: 120, damping: 24 }}
        />
        <span className={styles.mark} data-kind="max" style={{ left: pos(maxLtvBps) }} />
        <span className={styles.mark} data-kind="liq" style={{ left: pos(liquidationLtvBps) }} />
      </div>
      <div className={styles.scale}>
        <span>
          <i data-kind="max" aria-hidden /> {maxLabel} <b className="num">{formatBpsAsPercent(maxLtvBps, 0)}</b>
        </span>
        <span>
          <i data-kind="liq" aria-hidden /> Liquidation <b className="num">{formatBpsAsPercent(liquidationLtvBps, 0)}</b>
        </span>
      </div>
      {liquidationPrice !== null && solPrice !== null && (
        <p className={styles.line}>
          {solPrice <= liquidationPrice ? "SOL is at " : "Liquidation if SOL falls below "}
          <b className="num">${(solPrice <= liquidationPrice ? solPrice : liquidationPrice).toFixed(2)}</b>
          {solPrice > liquidationPrice
            ? ` · ${((1 - liquidationPrice / solPrice) * 100).toFixed(1)}% below today's $${solPrice.toFixed(2)}`
            : `, past this loan's line at $${liquidationPrice.toFixed(2)}`}
        </p>
      )}
      {stale && <p className={styles.stale}>The SOL price is too old. Wait for a fresh price and try again.</p>}
    </div>
  );
}
