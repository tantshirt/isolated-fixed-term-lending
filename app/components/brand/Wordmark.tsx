import Link from "next/link";
import { BRAND } from "@/lib/constants";
import { Mark } from "./Mark";
import styles from "./Wordmark.module.css";

/** The pebble-and-wave mark plus the name. LogoMark stays the progress ring used inside the app. */
export function Wordmark() {
  return (
    <Link
      href="/"
      className={styles.wordmark}
      aria-label={`${BRAND.name}, home`}
    >
      <Mark size={34} className={styles.mark} />
      <span className={styles.name}>{BRAND.name}</span>
    </Link>
  );
}
