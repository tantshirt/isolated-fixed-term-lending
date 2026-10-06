"use client";
import { RPC_URL, NETWORK } from "../constants";
let registration: Promise<void> | undefined;
/** Register without connecting. Only an explicit wallet choice may request accounts. */
export function registerMetaMask(): Promise<void> {
  if (NETWORK !== "devnet") return Promise.resolve();
  if (!registration)
    registration = import("@metamask/connect-solana")
      .then(async ({ createSolanaClient }) => {
        const client = await createSolanaClient({
          skipAutoRegister: true,
          dapp: {
            name: "LegitShark",
            url: window.location.origin,
            iconUrl: `${window.location.origin}/icon.png`,
          },
          api: { supportedNetworks: { devnet: RPC_URL } },
        });
        await client.registerWallet();
      })
      .catch((error) => {
        registration = undefined;
        throw error;
      });
  return registration;
}
export function hasInjectedMetaMask(): boolean {
  const ethereum = (
    window as Window & {
      ethereum?: {
        isMetaMask?: boolean;
        providers?: { isMetaMask?: boolean }[];
      };
    }
  ).ethereum;
  return Boolean(
    ethereum?.isMetaMask || ethereum?.providers?.some((p) => p.isMetaMask)
  );
}
