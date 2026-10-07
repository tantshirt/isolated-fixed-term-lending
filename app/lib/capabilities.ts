/**
 * Provider capabilities are code, keyed by network and mint, so an operational flag can pause a
 * capability but never enable one that was not proven. Unsupported actions carry a reason.
 */
export type Network = "devnet" | "localnet" | "mainnet";
export type Provider = "zenlo-public" | "zenlo-private" | "moneygram" | "telegram" | "umbra" | "privacy-cash" | "sas" | "reclaim";
export type Operation = "originate" | "service" | "refinance" | "automate" | "cash-out" | "cash-in" | "notify" | "shield" | "credential" | "resell" | "export";

export type Capability = {
  provider: Provider;
  network: Network;
  /** Mint the capability applies to, or "*" when it does not move tokens. */
  mint: string;
  operation: Operation;
  available: boolean;
  /** Said to the user when unavailable. */
  reason?: string;
  /** True when the only working form is a labelled simulation. */
  simulationOnly?: boolean;
};

export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const WSOL = "So11111111111111111111111111111111111111112";

/** Cash-in needs MoneyGram connected and its own switch; either alone is not enough. */
export function cashInEnabled(moneygram: string | undefined, cashIn: string | undefined): boolean {
  return moneygram === "1" && cashIn === "1";
}
/** ZenLo's Devnet "jitoSOL (test)" mint, when this deployment has one (Story 26.2). */
export const JITOSOL_TEST_MINT = process.env.NEXT_PUBLIC_JITOSOL_MINT ?? "";

/** Story 26.7: the invited credit pilot ("1" or "true"). */
const CREDIT_PILOT = process.env.NEXT_PUBLIC_CREDIT_PILOT_ENABLED === "1" || process.env.NEXT_PUBLIC_CREDIT_PILOT_ENABLED === "true";

export const CAPABILITIES: Capability[] = [
  { provider: "zenlo-public", network: "devnet", mint: DEVNET_USDC, operation: "originate", available: true },
  { provider: "zenlo-public", network: "devnet", mint: DEVNET_USDC, operation: "service", available: true },
  {
    provider: "zenlo-public",
    network: "devnet",
    mint: JITOSOL_TEST_MINT || "jitosol-test-unset",
    operation: "originate",
    // jitoSOL (test) collateral on isolated_loan_v2: on once governance has written its
    // CollateralConfig through a Squads proposal and the deployment sets the flag and mint.
    available: process.env.NEXT_PUBLIC_JITOSOL_ENABLED === "1" && JITOSOL_TEST_MINT !== "",
    reason: "jitoSOL (test) collateral is not enabled on this deployment yet.",
  },
  {
    provider: "zenlo-public",
    network: "devnet",
    mint: JITOSOL_TEST_MINT || "jitosol-test-unset",
    operation: "service",
    // The flag pauses new jitoSOL loans only; existing ones stay serviceable.
    available: JITOSOL_TEST_MINT !== "",
    reason: "This deployment has no jitoSOL (test) mint.",
  },
  {
    provider: "zenlo-public",
    network: "devnet",
    mint: DEVNET_USDC,
    operation: "refinance",
    // Story 26.1: `refinance_into` on isolated_loan_v2. On once the upgrade carrying it has passed
    // the Squads vault and its 24-hour time lock.
    available: process.env.NEXT_PUBLIC_REFINANCE_ENABLED === "1",
    reason: "Refinancing is not enabled on this deployment yet.",
  },
  {
    provider: "zenlo-public",
    network: "devnet",
    mint: DEVNET_USDC,
    operation: "automate",
    // Story 26.3: automation mandates on isolated_loan_v2, executed only by the configured
    // keeper. On once the upgrade has passed the Squads vault and its 24-hour time lock.
    available: process.env.NEXT_PUBLIC_MANDATES_ENABLED === "1",
    reason: "Automatic top-ups and repayments are not enabled on this deployment yet.",
  },
  {
    provider: "zenlo-public",
    network: "devnet",
    mint: DEVNET_USDC,
    operation: "resell",
    // Story 26.8: list_position / buy_position on isolated_loan_v2. On once the upgrade has passed
    // the Squads vault and its 24-hour time lock.
    available: process.env.NEXT_PUBLIC_SECONDARY_MARKET_ENABLED === "1",
    reason: "Selling positions is not enabled on this deployment yet.",
  },
  {
    provider: "zenlo-public",
    network: "devnet",
    mint: "*",
    operation: "export",
    // Story 26.8: client-only CSV of on-chain activity; no server holds the rows.
    available: process.env.NEXT_PUBLIC_EXPORT_ENABLED === "1",
    reason: "Activity export is not enabled on this deployment yet.",
  },
  { provider: "zenlo-private", network: "devnet", mint: DEVNET_USDC, operation: "originate", available: true },
  {
    provider: "zenlo-private",
    network: "devnet",
    mint: DEVNET_USDC,
    operation: "resell",
    // Story 26.8: transfer_position on private_loan_v2, inside the rollup, with the reader swap.
    available: process.env.NEXT_PUBLIC_SECONDARY_MARKET_ENABLED === "1",
    reason: "Selling positions is not enabled on this deployment yet.",
  },
  {
    provider: "zenlo-private",
    network: "devnet",
    mint: "*",
    operation: "export",
    // Private rows are assembled only in the browser from rollup reads.
    available: process.env.NEXT_PUBLIC_EXPORT_ENABLED === "1",
    reason: "Activity export is not enabled on this deployment yet.",
  },
  { provider: "zenlo-private", network: "devnet", mint: DEVNET_USDC, operation: "service", available: true },
  {
    provider: "moneygram",
    network: "devnet",
    mint: DEVNET_USDC,
    operation: "cash-out",
    // MoneyGram's sandbox settles in this exact Devnet USDC mint (guides/web-solana, Step 5);
    // it is switched on per deployment once the sandbox keys and allowlisted domain exist.
    available: process.env.NEXT_PUBLIC_MONEYGRAM_ENABLED === "1",
    reason: "MoneyGram cash-out is not connected on this deployment yet.",
  },
  {
    provider: "moneygram",
    network: "devnet",
    mint: DEVNET_USDC,
    operation: "cash-in",
    // A separate switch from cash-out: it waits on confirmation that the sandbox delivers this
    // Devnet USDC mint. Literal env reads so Next.js inlines them in the browser bundle.
    available: cashInEnabled(process.env.NEXT_PUBLIC_MONEYGRAM_ENABLED, process.env.NEXT_PUBLIC_MONEYGRAM_CASH_IN_ENABLED),
    reason: "MoneyGram cash-in is not connected on this deployment yet.",
  },
  {
    provider: "telegram",
    network: "devnet",
    mint: "*",
    operation: "notify",
    // On once the deployment has a bot token and webhook secret.
    available: process.env.NEXT_PUBLIC_TELEGRAM_ENABLED === "1",
    reason: "Telegram alerts are not connected on this deployment yet.",
  },
  {
    provider: "umbra",
    network: "devnet",
    mint: WSOL,
    operation: "shield",
    // Spike 2026-10-07: Umbra's Devnet program and relayer list wSOL. On per deployment once the
    // manual recovery test (shield, clear storage, recover, unshield) is recorded.
    available: process.env.NEXT_PUBLIC_UMBRA_ENABLED === "1",
    reason: "Umbra shielding is not switched on for this deployment yet.",
  },
  {
    provider: "umbra",
    network: "devnet",
    mint: DEVNET_USDC,
    operation: "shield",
    available: false,
    reason: "Umbra's Devnet supports wSOL only.",
  },
  ...[WSOL, DEVNET_USDC].map(
    (mint): Capability => ({
      provider: "privacy-cash",
      network: "devnet",
      mint,
      operation: "shield",
      available: false,
      reason: "Privacy Cash has no public Devnet relayer, and its official SDK is mainnet-only.",
    }),
  ),
  {
    provider: "sas",
    network: "devnet",
    // Credit tiers apply to wSOL collateral only (research.md § Credit tiers).
    mint: WSOL,
    operation: "credential",
    // Story 26.7: on once the flag is set, the credential and schema exist on Devnet, and the
    // isolated_loan_v2 upgrade carrying CreditConfig has passed the Squads vault.
    available: CREDIT_PILOT && !!process.env.NEXT_PUBLIC_SAS_CREDENTIAL && !!process.env.NEXT_PUBLIC_SAS_SCHEMA,
    reason: "The credit pilot is invite-only and not enabled on this deployment yet.",
  },
  {
    provider: "reclaim",
    network: "devnet",
    mint: "*",
    operation: "credential",
    // Income proofs are verified server-side and discarded; on once a Reclaim app id exists.
    available: CREDIT_PILOT && !!process.env.NEXT_PUBLIC_RECLAIM_APP_ID,
    reason: "Income verification is not connected on this deployment yet.",
  },
];

export type Availability = { available: true } | { available: false; reason: string; simulationOnly: boolean };

const UNKNOWN = "This isn't available on this network for this asset.";

export function capabilityFor(provider: Provider, network: Network, mint: string, operation: Operation, list = CAPABILITIES): Availability {
  const c = list.find((x) => x.provider === provider && x.network === network && x.operation === operation && (x.mint === mint || x.mint === "*"));
  if (!c) return { available: false, reason: UNKNOWN, simulationOnly: false };
  return c.available ? { available: true } : { available: false, reason: c.reason ?? UNKNOWN, simulationOnly: !!c.simulationOnly };
}
