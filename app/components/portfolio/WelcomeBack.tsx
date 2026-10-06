"use client";

import Link from "next/link";
import { shortKey } from "@/lib/format";
import { usePortfolio } from "./usePortfolio";
import s from "./MyLoans.module.css";

/** A returning wallet sees what needs it before anything else. */
export function WelcomeBack() {
  const { wallet, portfolio } = usePortfolio();
  if (!wallet || !portfolio || portfolio.items.length === 0) return null;
  const n = portfolio.totals.attention;
  return (
    <Link href="/devnet/me" className={s.welcome} data-attention={n > 0 || undefined}>
      <span>
        <strong>Welcome back, {shortKey(wallet)}.</strong>{" "}
        {n > 0
          ? `${n === 1 ? "1 loan needs" : `${n} loans need`} your attention.`
          : `${portfolio.items.length === 1 ? "1 item" : `${portfolio.items.length} items`} on your desk, nothing urgent.`}
      </span>
      <span className={s.welcomeCta}>My loans →</span>
    </Link>
  );
}
