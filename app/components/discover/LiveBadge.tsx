import type { LiveStatus } from "@/lib/live-state";
import styles from "./Discover.module.css";

const WORDS: Record<LiveStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  polling: "Refreshing every 15 s",
  offline: "Devnet unreachable",
};

/** Says how current the list is. Color is never the only signal: the word changes too. */
export function LiveBadge({ status }: { status: LiveStatus }) {
  return (
    <span className={styles.live} data-status={status} role="status" aria-live="polite">
      <span className={styles.liveDot} aria-hidden />
      {WORDS[status]}
    </span>
  );
}
