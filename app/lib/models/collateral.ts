import { SOL_USD_FEED_ID_HEX, CAPS } from "../constants";
import { JITOSOL_TEST_MINT } from "../capabilities";
import type { CollateralAsset } from "./index";

/** JITOSOL/USD (research.md § Per-asset collateral). jitoSOL is never priced from SOL/USD. */
export const JITOSOL_USD_FEED_ID_HEX = "67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb";

/**
 * "jitoSOL (test)" is a ZenLo Devnet test mint priced by the real JITOSOL/USD feed (Story 26.2).
 * It is on only when the deployment sets `NEXT_PUBLIC_JITOSOL_ENABLED=1` and the test mint's
 * address in `NEXT_PUBLIC_JITOSOL_MINT`, after governance has written its `CollateralConfig`.
 */
export { JITOSOL_TEST_MINT };
export const JITOSOL_ENABLED = process.env.NEXT_PUBLIC_JITOSOL_ENABLED === "1" && JITOSOL_TEST_MINT !== "";

/**
 * Collateral the V2 public program accepts. wSOL uses the built-in constants; every other asset
 * needs a governance `CollateralConfig` with the same feed and caps as listed here.
 */
export const COLLATERAL_ASSETS: CollateralAsset[] = [
  {
    version: 1,
    symbol: "wSOL",
    label: "wSOL",
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
    label: "jitoSOL (test)",
    mint: JITOSOL_TEST_MINT,
    decimals: 9,
    feedIdHex: JITOSOL_USD_FEED_ID_HEX,
    // Provisional caps (research.md): 60% max LTV, 70% liquidation LTV.
    maxLtvBps: 6_000,
    liquidationLtvBps: 7_000,
    enabled: JITOSOL_ENABLED,
  },
];

export function collateralAsset(mint: string): CollateralAsset | null {
  if (!mint) return null;
  return COLLATERAL_ASSETS.find((a) => a.mint === mint && a.enabled) ?? null;
}

/** Assets a borrower may pick for a new loan on this deployment. */
export function selectableCollateral(): CollateralAsset[] {
  return COLLATERAL_ASSETS.filter((a) => a.enabled);
}
