import { SOL_USD_FEED_ID_HEX, CAPS } from "../constants";
import type { CollateralAsset } from "./index";

/** Collateral the programs accept. jitoSOL is listed so its limits are visible, but stays disabled (Epic 26). */
export const COLLATERAL_ASSETS: CollateralAsset[] = [
  {
    version: 1,
    symbol: "wSOL",
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
    feedIdHex: SOL_USD_FEED_ID_HEX,
    maxLtvBps: CAPS.maxLtvBps,
    liquidationLtvBps: CAPS.maxLiquidationLtvBps,
    enabled: true,
  },
  {
    version: 1,
    symbol: "jitoSOL",
    mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    decimals: 9,
    feedIdHex: "",
    maxLtvBps: 6_000,
    liquidationLtvBps: 7_000,
    enabled: false,
  },
];

export function collateralAsset(mint: string): CollateralAsset | null {
  return COLLATERAL_ASSETS.find((a) => a.mint === mint && a.enabled) ?? null;
}
