import { Sharky } from "./Sharky";
import styles from "./SharkyTip.module.css";

/** One line from Sharky under a wizard's summary. Plain words, no figures. */
export function SharkyTip({ children }: { children: string }) {
  return (
    <aside className={styles.tip} aria-label="Tip from Sharky">
      <Sharky pose="clipboard" size={72} className={styles.art} />
      <p aria-live="polite">{children}</p>
    </aside>
  );
}
