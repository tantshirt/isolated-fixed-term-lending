import Image from "next/image";
import Link from "next/link";
import { BRAND } from "@/lib/constants";
import styles from "./Wordmark.module.css";

/** Sharky's head plus the name. LogoMark stays the progress ring used inside the app. */
export function Wordmark() {
  return (
    <Link
      href="/"
      className={styles.wordmark}
      aria-label={`${BRAND.name}, home`}
    >
      <Image
        className={styles.head}
        src="/illustrations/sharky-avatar.webp"
        alt=""
        width={34}
        height={34}
        priority
      />
      <span className={styles.name}>
        Legit<span className={styles.accent}>Shark</span>
      </span>
    </Link>
  );
}
