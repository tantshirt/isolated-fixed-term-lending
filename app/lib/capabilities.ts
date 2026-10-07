/**
 * Provider capabilities are code, keyed by network and mint, so an operational flag can pause a
 * capability but never enable one that was not proven. Unsupported actions carry a reason.
 */
export type Network = "devnet" | "localnet" | "mainnet";
export type Provider = "zenlo-public" | "zenlo-private" | "moneygram" | "telegram" | "umbra";
export type Operation = "originate" | "service" | "cash-out" | "cash-in" | "notify" | "shield";

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

/** ZenLo's Devnet "jitoSOL (test)" mint, when this deployment has one (Story 26.2). */
export const JITOSOL_TEST_MINT = process.env.NEXT_PUBLIC_JITOSOL_MINT ?? "";

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
  { provider: "zenlo-private", network: "devnet", mint: DEVNET_USDC, operation: "originate", available: true },
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
    available: false,
    reason: "Cash-in is a later, separate journey.",
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
    mint: DEVNET_USDC,
    operation: "shield",
    available: false,
    reason: "Umbra's Devnet relayer does not list ZenLo's Devnet USDC.",
  },
];

export type Availability = { available: true } | { available: false; reason: string; simulationOnly: boolean };

const UNKNOWN = "This isn't available on this network for this asset.";

export function capabilityFor(provider: Provider, network: Network, mint: string, operation: Operation, list = CAPABILITIES): Availability {
  const c = list.find((x) => x.provider === provider && x.network === network && x.operation === operation && (x.mint === mint || x.mint === "*"));
  if (!c) return { available: false, reason: UNKNOWN, simulationOnly: false };
  return c.available ? { available: true } : { available: false, reason: c.reason ?? UNKNOWN, simulationOnly: !!c.simulationOnly };
}
