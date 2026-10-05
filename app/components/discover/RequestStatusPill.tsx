import { requestStatusTitle, type RequestStatusKey } from "@/lib/requests";
import styles from "@/components/ui/StatusPill.module.css";

const TONE: Record<RequestStatusKey, string> = { open: "open", funded: "repaid", cancelled: "cancelled" };

export function RequestStatusPill({ status }: { status: RequestStatusKey }) {
  return (
    <span className={`${styles.pill} ${styles[TONE[status]]}`}>
      <span className={styles.dot} aria-hidden />
      {requestStatusTitle(status)}
    </span>
  );
}
