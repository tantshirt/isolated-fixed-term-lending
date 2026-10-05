import Link from "next/link";
import { Wordmark } from "@/components/brand/Wordmark";
import s from "./Landing.module.css";

const COLUMNS = [
  { title: "Try it", links: [{ label: "Demo, no wallet", href: "/demo" }, { label: "Devnet offers", href: "/devnet" }, { label: "Create an offer", href: "/devnet/create" }] },
  { title: "Private", links: [{ label: "Private rooms", href: "/devnet/private" }, { label: "Discover", href: "/devnet/private/discover" }, { label: "Liquidation quotes", href: "/devnet/private/liquidate" }] },
  { title: "Learn", links: [{ label: "Use cases", href: "/use-cases" }, { label: "How it works", href: "/#how-it-works" }, { label: "What is proven", href: "/devnet/private/proof" }] },
];

export function SiteFooter() {
  return (
    <footer className={s.siteFooter}>
      <div className={s.footerBrand}>
        <Wordmark />
        <p>Clear terms. One loan at a time.</p>
        <p className={s.note}>Built on Solana and MagicBlock. Devnet only, with test assets. Nothing here is a guaranteed return.</p>
      </div>
      {COLUMNS.map((c) => (
        <nav key={c.title} aria-label={c.title} className={s.footerCol}>
          <p className={s.footerTitle}>{c.title}</p>
          <ul>
            {c.links.map((l) => (
              <li key={l.href}>
                <Link href={l.href}>{l.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
      ))}
    </footer>
  );
}
