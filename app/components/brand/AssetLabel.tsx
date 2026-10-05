import type { ReactNode } from "react";
import styles from "./AssetLabel.module.css";
export type AssetSymbol = "USDC" | "SOL" | "wSOL";
export function AssetIcon({
  symbol,
  size = 32,
}: {
  symbol: AssetSymbol;
  size?: number;
}) {
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
      <span>{children ?? symbol}</span>
    </span>
  );
}
