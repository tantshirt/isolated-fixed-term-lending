"use client";

import { useEffect, useMemo, useState } from "react";
import { useChainNow, usePrice } from "@/lib/client/hooks";
import { useMyAccounts } from "@/lib/client/live";
import { useSigner } from "@/lib/client/signer-context";
import { buildPortfolio } from "@/lib/portfolio";
import { useOffersV2, useRequestsV2 } from "@/lib/v2/hooks";
import { V2_LIVE } from "@/lib/v2/program";

/** Wall-clock seconds that tick once a second, anchored to the chain clock when known. */
export function useNow(chainNow: number | null): number {
  const [local, setLocal] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setLocal(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, []);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (chainNow !== null) setOffset(chainNow - Math.floor(Date.now() / 1000));
  }, [chainNow]);
  return local + offset;
}

/** The connected wallet's loans, offers and requests, ordered by what needs attention first. */
export function usePortfolio() {
  const { publicKey } = useSigner();
  const wallet = publicKey?.toBase58() ?? null;
  const mine = useMyAccounts(wallet);
  const { price } = usePrice();
  const v2 = useOffersV2(V2_LIVE && !!wallet, wallet);
  const requestsV2 = useRequestsV2(V2_LIVE && !!wallet, 20_000, wallet);
  const now = useNow(useChainNow());
  // Reclassify once a minute; the countdown text ticks separately.
  const minute = Math.floor(now / 60);
  const portfolio = useMemo(
    () =>
      wallet && mine.offers && mine.requests
        ? buildPortfolio({ me: wallet, offers: mine.offers, requests: mine.requests, offersV2: v2 ?? [], requestsV2: requestsV2 ?? [], price, now: minute * 60 })
        : null,
    [wallet, mine.offers, mine.requests, v2, requestsV2, price, minute]
  );
  return { wallet, portfolio, now, status: mine.status, error: mine.error, loading: mine.loading };
}
