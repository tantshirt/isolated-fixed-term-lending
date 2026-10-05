import type { StatusKey } from "@/lib/offers";
import { statusTitle } from "@/lib/offer-status";
import styles from "./StatusPill.module.css";

export function StatusPill({ status, closed }: { status: StatusKey; closed?: boolean }) {
  return (
    <span className={`${styles.pill} ${styles[status]}`}>
      <span className={styles.dot} aria-hidden />
      {closed ? `Closed · ${statusTitle(status)}` : statusTitle(status)}
    </span>
  );
}

export type HealthTone = "good" | "watch" | "risk";

export function healthTone(healthBps: number): HealthTone {
  if (healthBps <= 0) return "risk";
  if (healthBps < 2_000) return "watch";
  return "good";
}

export function HealthPill({ healthBps }: { healthBps: number }) {
  const tone = healthTone(healthBps);
  const word = tone === "good" ? "Healthy" : tone === "watch" ? "Near the line" : "Can be liquidated";
  return (
    <span className={`${styles.pill} ${styles[tone]}`}>
      <span className={styles.dot} aria-hidden />
      {word} <span className="num">{(healthBps / 100).toFixed(1)}%</span>
    </span>
  );
}
