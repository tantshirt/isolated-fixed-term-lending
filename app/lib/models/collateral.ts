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

export const WSOL_ASSET = COLLATERAL_ASSETS[0];

/**
 * The asset that prices an existing loan or request, enabled or not: disabling an asset gates new
 * loans only, so servicing still needs its feed and label. An unknown mint (a local-mints build's
 * self-made mint, which the program prices as SOL) reads as wSOL.
 */
export function collateralForMint(mint: string | null | undefined): CollateralAsset {
  if (!mint) return WSOL_ASSET;
  return COLLATERAL_ASSETS.find((a) => a.mint !== "" && a.mint === mint) ?? WSOL_ASSET;
}

/**
 * The asset a new draft names: wSOL when it names none, otherwise only an asset this deployment
 * enables. `null` means the draft names collateral that cannot originate here.
 */
export function draftCollateral(mint: string | null | undefined): CollateralAsset | null {
  if (!mint || mint === WSOL_ASSET.mint) return WSOL_ASSET;
  return collateralAsset(mint);
}

/** True when the asset is priced by its own feed instead of the built-in SOL/USD account. */
export function hasOwnFeed(asset: CollateralAsset): boolean {
  return asset.mint !== WSOL_ASSET.mint;
}

/**
 * USDC value of `amount` collateral atoms, the same integer math as
 * `loan_core::math::collateral_value_usdc_decimals`:
 * `floor(amount × (price − conf) / 10^(decimals − 6 − exponent))`.
 */
export function collateralValueAtoms(amount: bigint, decimals: number, price: bigint, conf: bigint, exponent: number): bigint {
  if (price <= 0n || conf >= price) throw new Error("Invalid price");
  if (exponent < -12 || exponent > -3) throw new Error("Invalid exponent");
  const divisorExp = decimals - 6 - exponent;
  if (!Number.isInteger(divisorExp) || divisorExp < 0) throw new Error("Math overflow");
  return (amount * (price - conf)) / 10n ** BigInt(divisorExp);
}

/**
 * The draft patch for switching a new offer or request to `asset`: its mint (none for wSOL), with
 * both LTV limits brought inside the asset's caps and the 5-point gap kept.
 */
export function switchCollateral(
  draft: { maxLtvBps: number; liquidationLtvBps: number },
  asset: CollateralAsset,
): { collateralMint: string | undefined; maxLtvBps: number; liquidationLtvBps: number } {
  const liq = Math.min(draft.liquidationLtvBps, asset.liquidationLtvBps, CAPS.maxLiquidationLtvBps);
  const max = Math.min(draft.maxLtvBps, asset.maxLtvBps, CAPS.maxLtvBps, liq - CAPS.minLtvGapBps);
  return { collateralMint: asset.mint === WSOL_ASSET.mint ? undefined : asset.mint, maxLtvBps: max, liquidationLtvBps: liq };
}
