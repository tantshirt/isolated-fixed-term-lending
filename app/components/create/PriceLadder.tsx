"use client";

import { m } from "motion/react";
import styles from "./PriceLadder.module.css";

/**
 * SOL price on one axis: where it trades now, where a borrower could no longer accept,
 * and where the loan can be liquidated. Distance from now is the cushion, in words too.
 */
export function PriceLadder({ now, acceptBelow, liquidateBelow }: { now: number; acceptBelow: number; liquidateBelow: number }) {
  const top = Math.max(now, acceptBelow) * 1.12;
  const pos = (v: number) => `${Math.max(0, Math.min(100, (v / top) * 100))}%`;
  const drop = (v: number) => Math.max(0, (1 - v / now) * 100);
  const spring = { type: "spring", stiffness: 260, damping: 34 } as const;

  return (
    <div className={styles.ladder}>
      <div className={styles.track}>
        <m.span className={styles.zoneRisk} animate={{ width: pos(liquidateBelow) }} transition={spring} />
        <m.span className={styles.zoneWatch} animate={{ left: pos(liquidateBelow), width: `calc(${pos(acceptBelow)} - ${pos(liquidateBelow)})` }} transition={spring} />
        <m.span className={styles.marker} data-kind="liq" animate={{ left: pos(liquidateBelow) }} transition={spring} />
        <m.span className={styles.marker} data-kind="accept" animate={{ left: pos(acceptBelow) }} transition={spring} />
        <m.span className={styles.now} animate={{ left: pos(now) }} transition={spring}>
          <span className={styles.nowLabel}>
            SOL now <b className="num">${now.toFixed(2)}</b>
          </span>
        </m.span>
      </div>
      <dl className={styles.legend}>
        <div>
          <dt>
            <i data-kind="accept" aria-hidden /> Borrowers can accept above
          </dt>
          <dd className="num">${acceptBelow.toFixed(2)}</dd>
        </div>
        <div>
          <dt>
            <i data-kind="liq" aria-hidden /> Liquidation below
          </dt>
          <dd className="num">
            ${liquidateBelow.toFixed(2)} <span className={styles.drop}>a {drop(liquidateBelow).toFixed(0)}% fall</span>
          </dd>
        </div>
      </dl>
    </div>
  );
}
