import { STALE_PRICE_MESSAGE } from "./constants";

/** One plain sentence per program error (error.rs), in the product's voice. */
const ERROR_MESSAGES: Record<string, string> = {
  WrongStatus: "This loan has already moved on. Refresh to see where it stands.",
  MathOverflow: "Those numbers are too large for the program to hold.",
  InsufficientCollateral: "At today's SOL price this collateral is past the offer's max LTV.",
  LoanHealthy: "This loan is healthy, so it cannot be liquidated.",
  UnauthorizedLender: "Only the lender can do that.",
  UnauthorizedBorrower: "Only the borrower can do that.",
  SameBorrowerAndLender: "You cannot borrow from your own offer. Switch to another wallet.",
  BorrowerCannotLiquidate: "A borrower cannot liquidate their own loan. Repay it instead.",
  InvalidTerms: "Those terms are outside Tenor's limits.",
  LoanExpired: "The deadline has passed. The lender can now claim the collateral.",
  LoanNotExpired: "The deadline has not passed yet.",
  InvalidPriceOwner: "The price account is not owned by Pyth.",
  InvalidFeedId: "The price account is not the SOL/USD feed.",
  StalePrice: STALE_PRICE_MESSAGE,
  InvalidPrice: "The SOL price is too uncertain right now. Try again in a moment.",
  InvalidExponent: "The SOL price is in an unexpected format.",
  ZeroCollateralValue: "The collateral is worth nothing at this price.",
  InvalidUsdcMint: "That USDC mint does not have 6 decimals.",
  InvalidWsolMint: "That wSOL mint does not have 9 decimals.",
  SameMint: "USDC and wSOL must be different tokens.",
  OfferNotSettled: "Only a settled offer can be closed.",
};

const WALLET_MESSAGES: [RegExp, string][] = [
  [/user rejected|rejected the request|denied/i, "You declined the request in your wallet."],
  [/insufficient (funds|lamports)|0x1\b/i, "This wallet does not hold enough for that. Fund it from the account menu."],
  [/blockhash not found|block height exceeded/i, "The network took too long. Try again."],
  [/failed to fetch|network|ECONNREFUSED/i, "Tenor cannot reach the local validator. Is Surfpool running?"],
];

export function messageFromAnchorError(err: unknown): string {
  const msg = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err ?? "");
  const logs =
    err && typeof err === "object" && "logs" in err && Array.isArray((err as { logs: unknown }).logs)
      ? (err as { logs: string[] }).logs.join(" ")
      : "";
  const haystack = `${msg} ${logs}`;
  for (const [code, text] of Object.entries(ERROR_MESSAGES)) {
    if (haystack.includes(code)) return text;
  }
  for (const [re, text] of WALLET_MESSAGES) {
    if (re.test(haystack)) return text;
  }
  return "The transaction did not go through. Nothing moved.";
}
