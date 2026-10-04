"use client";

import { formatCountdown, formatDeadline } from "@/lib/format";
import styles from "./TermRing.module.css";

const R = 34;
const C = 2 * Math.PI * R;

/** Time left on the loan as a brass arc that drains toward the deadline. */
export function TermRing({ startTs, expiryTs, now }: { startTs: number; expiryTs: number; now: number }) {
  const total = Math.max(1, expiryTs - startTs);
  const left = Math.max(0, expiryTs - now);
  const remaining = left / total;
  const done = left === 0;
  return (
    <div className={styles.wrap} data-done={done || undefined}>
      <svg width="84" height="84" viewBox="0 0 84 84" aria-hidden>
        <circle cx="42" cy="42" r={R} className={styles.track} />
        <circle
          cx="42"
          cy="42"
          r={R}
          className={styles.arc}
          strokeDasharray={`${remaining * C} ${C}`}
          transform="rotate(-90 42 42)"
        />
      </svg>
      <div>
        <p className={styles.label}>{done ? "Deadline passed" : "Time to repay"}</p>
        <p className={`${styles.count} num`}>{done ? "0s" : formatCountdown(left)}</p>
        <p className={styles.deadline}>Last second: {formatDeadline(expiryTs)}</p>
      </div>
    </div>
  );
}
