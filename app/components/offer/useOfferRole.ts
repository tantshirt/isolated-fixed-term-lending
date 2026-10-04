import type { Offer } from "@/lib/offers";

export type OfferRole = "lender" | "borrower" | "visitor";

/** Who you are to this loan is decided by the connected address, never by a menu. */
export function roleFor(offer: Offer, me: string | null): OfferRole {
  if (!me) return "visitor";
  if (me === offer.lender) return "lender";
  if (offer.borrower && me === offer.borrower) return "borrower";
  return "visitor";
}
