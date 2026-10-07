"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useChainNow } from "@/lib/client/hooks";
import { formatDeadline, formatUsdc, formatWsol } from "@/lib/format";
import { maturity, payoff } from "@/lib/loan-math-v2";
import { getConnection } from "@/lib/program";
import { SECONDARY_MARKET_ENABLED, fetchListings, listingState, type Listing } from "@/lib/v2/market";
import { fetchOffersV2, offerV2Href, type OfferV2 } from "@/lib/v2/offers";
import styles from "./Discover.module.css";
import list from "@/components/offers/OffersPage.module.css";
import row from "@/components/offers/OfferRow.module.css";

type ForSale = { listing: Listing; offer: OfferV2 };

/** Buyable listings joined to their loans; `null` while loading. */
function useForSale(enabled: boolean): ForSale[] | null {
  const [rows, setRows] = useState<ForSale[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    (async () => {
      try {
        const c = getConnection();
        const [listings, offers] = await Promise.all([fetchListings(c), fetchOffersV2(c)]);
        const byKey = new Map(offers.map((o) => [o.publicKey, o]));
        const joined = listings.flatMap((l) => {
          const offer = byKey.get(l.offer);
          return offer ? [{ listing: l, offer }] : [];
        });
        if (live) setRows(joined);
      } catch {
        if (live) setRows([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled]);
  return rows;
}

/**
 * Story 26.8: V2 positions their lenders have listed. Buying one makes the buyer the lender; the
 * borrower's terms never change.
 */
export function PositionsForSale() {
  const rows = useForSale(SECONDARY_MARKET_ENABLED);
  const now = useChainNow();
  if (!SECONDARY_MARKET_ENABLED || rows === null || now === null) return null;
  const buyable = rows.filter((r) => listingState(r.listing, r.offer, now) === "buyable").sort((a, b) => (a.listing.price < b.listing.price ? -1 : 1));
  if (buyable.length === 0) return null;
  return (
    <section className={styles.mine} aria-labelledby="for-sale-heading">
      <h2 id="for-sale-heading" className={styles.mineTitle}>
        Positions for sale
      </h2>
      <p className={styles.venueCopy}>Buy a running loan from its lender. You receive every later payment; the borrower&apos;s terms do not change.</p>
      <ul className={list.list}>
        <li className={list.header} aria-hidden>
          <span>Price</span>
          <span>Owed now</span>
          <span>Deadline</span>
          <span>Collateral</span>
          <span>Listing</span>
        </li>
        {buyable.map(({ listing, offer }) => (
          <li key={listing.publicKey}>
            <Link href={offerV2Href(offer)} className={row.row}>
              <span className={row.principal}>
                <span className={`${row.big} num`}>{formatUsdc(listing.price)}</span>
                <span className={row.unit}>USDC</span>
              </span>
              <span className={row.cell} data-label="Owed now">
                <span className="num">{formatUsdc(payoff(offer.terms, offer.ledger, now))}</span>
                <span className={row.sub}>of {formatUsdc(offer.terms.principal)} USDC lent</span>
              </span>
              <span className={row.cell} data-label="Deadline">
                <span>{formatDeadline(maturity(offer.terms))}</span>
              </span>
              <span className={row.cell} data-label="Collateral">
                <span className="num">{formatWsol(offer.collateralLocked)} wSOL</span>
              </span>
              <span className={row.status}>
                <span className={row.sub}>Until {formatDeadline(listing.expiry)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
