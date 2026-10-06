"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "@/components/brand/Wordmark";
import { useDevConfig } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { usePortfolio } from "@/components/portfolio/usePortfolio";
import { AccountButton } from "./AccountButton";
import styles from "./Header.module.css";

const NAV = [
  { href: "/devnet/discover", label: "Discover" },
  { href: "/devnet", label: "Offers" },
  { href: "/devnet/learn", label: "Learn" },
  { href: "/devnet/private", label: "Private" },
];

export function Header() {
  const pathname = usePathname();
  const { localControls } = useDevConfig();
  const { setDeskOpen, publicKey } = useSigner();
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Wordmark />
        <nav className={styles.nav} aria-label="Main">
          {publicKey && <MyLoansLink active={pathname.startsWith("/devnet/me")} />}
          {NAV.map((n) => {
            const active =
              n.href === "/devnet"
                ? pathname === "/devnet" ||
                  pathname.startsWith("/devnet/offers") || pathname.startsWith("/devnet/create")
                : n.href === "/devnet/discover"
                ? pathname.startsWith("/devnet/discover") ||
                  pathname.startsWith("/devnet/requests")
                : n.href === "/devnet/private"
                  ? pathname.startsWith("/devnet/private")
                  : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={styles.link}
                aria-current={active ? "page" : undefined}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className={styles.end}>
          {localControls && (
            <button
              type="button"
              className={styles.desk}
              onClick={() => setDeskOpen(true)}
            >
              <span className={styles.deskDot} aria-hidden />
              Local desk
            </button>
          )}
          <AccountButton />
        </div>
      </div>
    </header>
  );
}

/** Shown once a wallet is connected; the badge counts loans that need attention. */
function MyLoansLink({ active }: { active: boolean }) {
  const { portfolio } = usePortfolio();
  const n = portfolio?.totals.attention ?? 0;
  return (
    <Link href="/devnet/me" className={styles.link} aria-current={active ? "page" : undefined}>
      My loans
      {n > 0 && (
        <span className={styles.badge} aria-label={`${n} need attention`}>
          {n}
        </span>
      )}
    </Link>
  );
}
