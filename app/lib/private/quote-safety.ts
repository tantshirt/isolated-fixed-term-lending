import type { PublicKey } from "@solana/web3.js";
import type { Quote } from "./liquidation";

/** A fresh read must still match the terms the person reviewed before signing. */
export function verifyQuoteAction(reviewed: Quote, fresh: Quote | undefined, wallet: PublicKey, funding: boolean, now: number): Quote {
  if (!fresh || !fresh.address.equals(reviewed.address) || fresh.revision !== reviewed.revision || fresh.debt !== reviewed.debt || fresh.payout !== reviewed.payout) {
    throw new Error("This quote changed. Refresh and review the new terms.");
  }
  if (funding) {
    if (fresh.state !== "open" || fresh.expiresAt <= now || fresh.tickets.length >= 4) throw new Error("This quote is no longer available to fund.");
  } else {
    const ticket = fresh.tickets.find((t) => t.liquidator.equals(wallet) && (t.state === "funded" || t.state === "won"));
    const refund = ticket?.state === "funded" && (fresh.state !== "open" || ticket.revision !== fresh.revision || fresh.expiresAt < now);
    if (!ticket || (ticket.state !== "won" && !refund)) throw new Error("This ticket is not ready to collect or refund. Refresh its status.");
  }
  return fresh;
}
