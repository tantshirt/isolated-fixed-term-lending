import styles from "./Tip.module.css";

/** One plain-language line under a wizard's summary. No figures. */
export function Tip({ children }: { children: string }) {
  return (
    <aside className={styles.tip} aria-label="Tip">
      <span className={styles.icon} aria-hidden>
        i
      </span>
      <p aria-live="polite">{children}</p>
    </aside>
  );
}
