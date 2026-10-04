"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "@/components/brand/Wordmark";
import { useSigner } from "@/lib/client/signer-context";
import { AccountButton } from "./AccountButton";
import styles from "./Header.module.css";

const NAV = [
  { href: "/", label: "Offers" },
  { href: "/create", label: "Create offer" },
];

export function Header() {
  const pathname = usePathname();
  const { setDeskOpen } = useSigner();
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Wordmark />
        <nav className={styles.nav} aria-label="Main">
          {NAV.map((n) => {
            const active = n.href === "/" ? pathname === "/" || pathname.startsWith("/offers") : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} className={styles.link} aria-current={active ? "page" : undefined}>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className={styles.end}>
          <button type="button" className={styles.desk} onClick={() => setDeskOpen(true)}>
            <span className={styles.deskDot} aria-hidden />
            Demo desk
          </button>
          <AccountButton />
        </div>
      </div>
    </header>
  );
}
