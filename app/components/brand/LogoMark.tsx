import styles from "./LogoMark.module.css";

type Props = {
  size?: number;
  /** 0..1 fills the brass arc; used for wizard progress and term remaining. */
  progress?: number;
  /** Turns the arc into the pending-transaction indicator. */
  spinning?: boolean;
  /** "ink" on light surfaces, "panel" on the deep green. */
  tone?: "ink" | "panel";
  title?: string;
};

const R = 13;
const C = 2 * Math.PI * R;

/**
 * LegitShark's progress ring (the brand logo is Sharky's head in Wordmark): a ring (the term) crowned by a brass arc, with a stem that makes the
 * pair read as a T. The arc length is live: it carries progress wherever the mark appears.
 */
export function LogoMark({
  size = 28,
  progress = 0.25,
  spinning = false,
  tone = "ink",
  title,
}: Props) {
  const p = Math.min(1, Math.max(0, progress));
  return (
    <svg
      className={`${styles.mark} ${styles[tone]} ${
        spinning ? styles.spinning : ""
      }`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <circle className={styles.ring} cx="16" cy="16" r={R} />
      <circle
        className={styles.arc}
        cx="16"
        cy="16"
        r={R}
        strokeDasharray={`${Math.max(0.001, p) * C} ${C}`}
        transform="rotate(-90 16 16)"
        style={{ ["--arc" as string]: `${p * C}` }}
      />
      <path
        d="M10 22V10M10 22h12M15 17l7-7M16 10h6v6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
