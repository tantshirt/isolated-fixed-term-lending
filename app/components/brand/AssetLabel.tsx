import type { ReactNode } from "react";
import { COLLATERAL_ASSETS } from "@/lib/models/collateral";
import styles from "./AssetLabel.module.css";
export type AssetSymbol = "USDC" | "SOL" | "wSOL" | "jitoSOL";

/** jitoSOL has no sourced artwork, so it is always a text label ("jitoSOL (test)" on Devnet). */
const TEXT_ONLY: Partial<Record<AssetSymbol, string>> = {
  jitoSOL: COLLATERAL_ASSETS.find((a) => a.symbol === "jitoSOL")?.label ?? "jitoSOL",
};

export function AssetIcon({
  symbol,
  size = 32,
}: {
  symbol: AssetSymbol;
  size?: number;
}) {
  if (TEXT_ONLY[symbol]) return null;
  // Official artwork is hosted locally; the adjacent label names the asset.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={styles.icon}
      src={`/brands/${symbol === "USDC" ? "usdc" : "solana"}.svg`}
      alt=""
      width={size}
      height={size}
    />
  );
}
export function AssetLabel({
  symbol,
  children,
}: {
  symbol: AssetSymbol;
  children?: ReactNode;
}) {
  return (
    <span className={styles.label}>
      <AssetIcon symbol={symbol} />
      <span>{children ?? TEXT_ONLY[symbol] ?? symbol}</span>
    </span>
  );
}
