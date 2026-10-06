import styles from "./Mark.module.css";

const PEBBLE =
  "M12.5 40.5C12.5 28.5 22 15.5 33 15.5C43.5 15.5 51.5 27 51.5 37.5C51.5 45.5 43 49.5 32 49.5C20 49.5 12.5 47 12.5 40.5Z";
const WAVE = "M11 35.5C17.5 27.5 25 28 31.5 33C38 38 45 40.5 53 35";

/** ZenLo's mark: a pebble crossed by a wave, on a rounded tile. `bare` drops the tile. */
export function Mark({
  size = 34,
  bare = false,
  className,
}: {
  size?: number;
  bare?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={[styles.mark, bare ? styles.bare : "", className ?? ""].join(" ")}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      {!bare && <rect className={styles.tile} width="64" height="64" rx="16" />}
      <path className={styles.pebble} d={PEBBLE} />
      <path className={styles.wave} d={WAVE} />
    </svg>
  );
}
