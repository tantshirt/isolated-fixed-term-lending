import styles from "./Skeleton.module.css";

export function Skeleton({ width = "100%", height = "1em" }: { width?: string; height?: string }) {
  return <span className={styles.skeleton} style={{ width, height }} aria-hidden />;
}
