/**
 * Provider capabilities are code, keyed by network and mint, so an operational flag can pause a
 * capability but never enable one that was not proven. Unsupported actions carry a reason.
 */
export type Network = "devnet" | "localnet" | "mainnet";
export type Provider = "zenlo-public" | "zenlo-private" | "moneygram" | "telegram" | "umbra" | "privacy-cash";
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

/** Cash-in needs MoneyGram connected and its own switch; either alone is not enough. */
export function cashInEnabled(moneygram: string | undefined, cashIn: string | undefined): boolean {
  return moneygram === "1" && cashIn === "1";
}

export const CAPABILITIES: Capability[] = [
  { provider: "zenlo-public", network: "devnet", mint: DEVNET_USDC, operation: "originate", available: true },
  { provider: "zenlo-public", network: "devnet", mint: DEVNET_USDC, operation: "service", available: true },
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
];

export type Availability = { available: true } | { available: false; reason: string; simulationOnly: boolean };

const UNKNOWN = "This isn't available on this network for this asset.";

export function capabilityFor(provider: Provider, network: Network, mint: string, operation: Operation, list = CAPABILITIES): Availability {
  const c = list.find((x) => x.provider === provider && x.network === network && x.operation === operation && (x.mint === mint || x.mint === "*"));
  if (!c) return { available: false, reason: UNKNOWN, simulationOnly: false };
  return c.available ? { available: true } : { available: false, reason: c.reason ?? UNKNOWN, simulationOnly: !!c.simulationOnly };
}
