import Link from "next/link";
import { BRAND } from "@/lib/constants";
import { LogoMark } from "./LogoMark";
import styles from "./Wordmark.module.css";

export function Wordmark() {
  return (
    <Link
      href="/"
      className={styles.wordmark}
      aria-label={`${BRAND.name}, home`}
    >
      <LogoMark size={26} />
      <span className={styles.name}>{BRAND.name}</span>
    </Link>
  );
}
