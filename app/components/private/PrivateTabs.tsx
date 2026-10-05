"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import styles from "./PrivateTabs.module.css";

const MAIN = [
  { href: "/devnet/private", label: "Overview" },
  { href: "/devnet/private/discover", label: "Discover" },
  { href: "/devnet/private/liquidate", label: "Liquidations" },
  { href: "/devnet/private/lab", label: "Loan lab" },
];

const MORE = [
  { href: "/devnet/private/diagnostics", label: "Diagnostics" },
  { href: "/devnet/private/proof", label: "Proof" },
];

/** Section navigation for every private route. Rooms count as Overview. */
export function PrivateTabs() {
  const pathname = usePathname();
  const nav = useRef<HTMLElement>(null);

  // On narrow screens the strip scrolls; keep the current tab in view.
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);
  const isActive = (href: string) =>
    href === "/devnet/private"
      ? pathname === href || pathname.startsWith("/devnet/private/rooms")
      : pathname.startsWith(href);

  const link = (t: { href: string; label: string }, cls: string) => (
    <Link key={t.href} href={t.href} className={cls} aria-current={isActive(t.href) ? "page" : undefined}>
      {t.label}
    </Link>
  );

  return (
    <div className={styles.bar}>
      <nav ref={nav} className={styles.inner} aria-label="Private">
        <span className={styles.label}>Private</span>
        <div className={styles.tabs}>{MAIN.map((t) => link(t, styles.tab))}</div>
        <div className={styles.more}>{MORE.map((t) => link(t, styles.minor))}</div>
      </nav>
    </div>
  );
}
