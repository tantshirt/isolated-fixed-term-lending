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
    available: false,
    simulationOnly: true,
    reason: "MoneyGram's sandbox has not been proven with ZenLo's Devnet USDC yet.",
  },
  {
    provider: "moneygram",
    network: "devnet",
    mint: DEVNET_USDC,
    operation: "cash-in",
    available: false,
    reason: "Cash-in is a later, separate journey.",
  },
  { provider: "telegram", network: "devnet", mint: "*", operation: "notify", available: false, reason: "Telegram alerts are not connected yet." },
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
