import Link from "next/link";
import { Wordmark } from "@/components/brand/Wordmark";
import s from "./Experience.module.css";
export function PublicHeader() {
  return (
    <div className={s.headerBar}>
      <header className={s.header}>
        <Wordmark />
        <nav className={s.nav} aria-label="Main navigation">
          <Link className={s.desktop} href="/#how-it-works">
            How it works
          </Link>
          <Link className={s.desktop} href="/use-cases">
            Use cases
          </Link>
          <Link className={s.desktop} href="/devnet/private">
            Private
          </Link>
          <Link href="/learn">Learn</Link>
          <Link className={`${s.navSoft} ${s.desktop}`} href="/devnet">
            Use Devnet
          </Link>
          <Link className={s.navSolid} href="/demo">
            Try the demo
          </Link>
        </nav>
      </header>
    </div>
  );
}
