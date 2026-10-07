"use client";

import { PublicKey } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { formatDeadline, formatUsdc, shortKey } from "@/lib/format";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { payoff } from "@/lib/loan-math-v2";
import { parseAmount } from "@/lib/offer-validation";
import { getConnection } from "@/lib/program";
import {
  SECONDARY_MARKET_ENABLED,
  buyBlocker,
  canList,
  fetchListing,
  listingState,
  sendBuyPositionV2,
  sendCancelListingV2,
  sendCloseListingV2,
  sendListPositionV2,
  type Listing,
} from "@/lib/v2/market";
import type { OfferV2 } from "@/lib/v2/offers";
import styles from "@/components/offer/ActionPanel.module.css";

type Props = {
  offer: OfferV2;
  signer: LoanSigner;
  now: number;
  busy: boolean;
  run: (fn: () => Promise<string>, moved: string) => Promise<void>;
  panel: (title: string, body: string, children?: React.ReactNode, note?: string | null) => React.ReactNode;
};

const DAY = 86_400;

/** This loan's listing; `undefined` while loading, `null` when there is none. */
function useListing(offer: string, refresh: number): Listing | null | undefined {
  const [row, setRow] = useState<Listing | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetchListing(getConnection(), new PublicKey(offer))
      .then((l) => live && setRow(l))
      .catch(() => live && setRow(null));
    return () => {
      live = false;
    };
  }, [offer, refresh]);
  return row;
}

/**
 * Story 26.8: the current lender lists, re-prices or cancels a sale of this position; any other
 * wallet except the borrower buys it at exactly the listed price; anyone closes a void listing so
 * the seller gets the rent back. The borrower's terms never change, only who is paid.
 */
export function ListingPanel({ offer, signer, now, busy, run, panel }: Props) {
  const [refresh, setRefresh] = useState(0);
  const listing = useListing(offer.publicKey, refresh);
  const [price, setPrice] = useState("");
  const [days, setDays] = useState("7");
  if (!SECONDARY_MARKET_ENABLED || listing === undefined) return null;

  const me = signer.publicKey.toBase58();
  const runAndRefresh = async (fn: () => Promise<string>, moved: string) => {
    await run(fn, moved);
    setRefresh((n) => n + 1);
  };
  const state = listing ? listingState(listing, offer, now) : null;
  const owed = offer.status === "active" ? payoff(offer.terms, offer.ledger, now) : 0n;

  // A void listing: anyone may close it; the rent returns to the seller.
  if (listing && state !== "buyable") {
    const why = state === "expired" ? "It has expired." : state === "stale" ? "Its seller no longer holds the position." : "The loan has settled.";
    return panel(
      "Void listing",
      `${why} Closing it returns its rent to the seller.`,
      <Button variant="secondary" size="lg" block loading={busy} onClick={() => runAndRefresh(() => sendCloseListingV2(signer, listing), "Listing closed. Rent returned to the seller.")}>
        Close the listing
      </Button>,
    );
  }

  // The current lender lists, updates or cancels.
  if (canList(offer, me, now)) {
    const atoms = parseAmount(price, 6);
    const expiry = now + Math.round(Number(days) * DAY);
    const problem = !atoms || atoms <= 0n ? "Enter a price above zero." : !Number.isFinite(expiry) || expiry <= now ? "Choose how long the listing stays open." : null;
    return panel(
      listing ? "Your position is for sale" : "Sell this position",
      listing
        ? `Listed at ${formatUsdc(listing.price)} USDC until ${formatDeadline(listing.expiry)}. The buyer receives every later payment, including interest already accrued.`
        : `The borrower owes ${formatUsdc(owed)} USDC now. A buyer pays your price at once and receives every later payment. The borrower's terms do not change.`,
      <>
        <AmountInput label="Price" value={price} onChange={setPrice} unit="USDC" decimals={6} />
        <AmountInput label="Open for" value={days} onChange={setDays} unit="days" decimals={0} />
        <Button
          size="lg"
          block
          loading={busy}
          disabled={!!problem}
          onClick={() => atoms && runAndRefresh(() => sendListPositionV2(signer, offer, atoms, expiry), listing ? `Listing updated to ${formatUsdc(atoms)} USDC` : `Listed for ${formatUsdc(atoms)} USDC`)}
        >
          {listing ? "Update the listing" : "List for sale"}
        </Button>
        {listing && (
          <Button variant="secondary" size="lg" block loading={busy} onClick={() => runAndRefresh(() => sendCancelListingV2(signer, listing), "Listing cancelled")}>
            Cancel the listing
          </Button>
        )}
      </>,
      problem && price !== "" ? problem : null,
    );
  }

  if (!listing) return null;
  const blocker = buyBlocker(listing, offer, me, now);
  if (blocker && me === listing.seller) return null;
  return panel(
    "Buy this position",
    `Pay ${formatUsdc(listing.price)} USDC to ${shortKey(listing.seller)} and become this loan's lender. The borrower owes ${formatUsdc(owed)} USDC now.`,
    <>
      <ul className={styles.review}>
        <li>You pay exactly {formatUsdc(listing.price)} USDC, once. If the seller changes the price first, your purchase fails and nothing moves.</li>
        <li>You receive every later payment, including interest that accrued before the sale.</li>
        <li>Any shortfall after a recovery is yours. The borrower&apos;s terms do not change.</li>
        <li>This listing ends {formatDeadline(listing.expiry)}.</li>
      </ul>
      <Button size="lg" block loading={busy} disabled={!!blocker} onClick={() => runAndRefresh(() => sendBuyPositionV2(signer, offer, listing), `You now hold this position for ${formatUsdc(listing.price)} USDC`)}>
        Buy for {formatUsdc(listing.price)} USDC
      </Button>
    </>,
    blocker,
  );
}
