export const WALLET_CATALOG = [
  {
    id: "phantom",
    name: "Phantom",
    icon: "/brands/phantom.svg",
    url: "https://phantom.com/download",
  },
  {
    id: "backpack",
    name: "Backpack",
    icon: "/brands/backpack.png",
    url: "https://backpack.app/",
  },
  {
    id: "jupiter",
    name: "Jupiter",
    icon: "/brands/jupiter.svg",
    url: "https://jup.ag/wallet",
  },
  {
    id: "metamask",
    name: "MetaMask",
    icon: "/brands/metamask.svg",
    url: "https://metamask.io/download",
  },
] as const;
export function walletBrand(name: string) {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  return WALLET_CATALOG.find(
    (w) =>
      normalized === w.id ||
      normalized === `${w.id}wallet` ||
      (w.id === "jupiter" && normalized === "jupitermobile")
  );
}
/** Solana signing must be available; an EVM-only extension is not a lending signer. */
export function walletUnavailableReason(
  adapter: object,
  network: "devnet" | "localnet"
): string | null {
  if ("wallet" in adapter) {
    const standard = adapter.wallet as {
      chains?: readonly string[];
      features?: Record<string, unknown>;
    };
    if (network === "devnet" && !standard.chains?.includes("solana:devnet"))
      return "Devnet unavailable";
    if (!standard.features?.["solana:signTransaction"])
      return "Solana signing unavailable";
    return null;
  }
  return "signTransaction" in adapter &&
    typeof adapter.signTransaction === "function"
    ? null
    : "Solana signing unavailable";
}
