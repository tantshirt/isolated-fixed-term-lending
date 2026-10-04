/** User-facing success lines from the design copy deck / shared states. */

export const SUCCESS = {
  createOffer: "USDC locked in the offer.",
  cancelOffer: "USDC returned to your wallet.",
  acceptOffer: "You received USDC.",
  repay: "You received your wSOL back.",
  claim: "You received the wSOL.",
  liquidate: "Collateral settled.",
} as const;

export function logTx(signature: string): void {
  if (process.env.NODE_ENV === "development") {
    console.info("[tx]", signature);
  }
}
