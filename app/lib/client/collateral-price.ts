"use client";

import type { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";
import { MAX_PRICE_AGE_SECONDS } from "@/lib/constants";
import type { CollateralAsset } from "@/lib/models";
import { hasOwnFeed } from "@/lib/models/collateral";
import { sharedRead } from "@/lib/shared-read";
import { feedKeyFor } from "@/lib/v2/collateral-accounts";
import { useBalances, usePrice, type DevConfig, type LivePrice } from "./hooks";

type FeedBody = { price: { price: string; conf: string; exponent: number; publishTime: number; emaPrice: string; emaConf: string } | null };

/**
 * The live price for a collateral asset (Story 26.2). wSOL reads the SOL/USD account as before.
 * An asset with its own feed reads the latest Hermes update through the app's relay: the
 * transaction that needs it posts a fresh copy first, so this is for display and pre-checks.
 */
export function useCollateralPrice(asset: CollateralAsset, ms = 10_000) {
  const sol = usePrice(ms);
  const own = hasOwnFeed(asset);
  const feed = feedKeyFor(asset);
  const [state, setState] = useState<{ feed: string; price: LivePrice | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!own) return;
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const body = await sharedRead<FeedBody>(`feed-price:${feed}`, async () => {
          const r = await fetch(`/api/pyth-update?feed=${feed}`, { cache: "no-store" });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error ?? "No price");
          return j;
        });
        const p = body.price;
        if (!p) throw new Error("No price");
        const now = Math.floor(Date.now() / 1000);
        if (alive)
          setState({
            feed,
            error: null,
            price: {
              price: BigInt(p.price),
              conf: BigInt(p.conf),
              exponent: p.exponent,
              publishTime: p.publishTime,
              fresh: now - p.publishTime <= MAX_PRICE_AGE_SECONDS,
              ema: { price: BigInt(p.emaPrice), conf: BigInt(p.emaConf) },
              chainTime: now,
              receivedAt: Date.now(),
            },
          });
      } catch (e) {
        if (alive) setState({ feed, price: null, error: e instanceof Error ? e.message : "No price" });
      }
    };
    load();
    const id = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [own, feed, ms]);

  if (!own) return sol;
  const current = state?.feed === feed ? state : null;
  return { price: current?.price ?? null, error: current?.error ?? null };
}

/** Wallet balances where `wsol` is the balance of the given collateral asset's mint. */
export function useCollateralBalances(publicKey: PublicKey | null, config: DevConfig | null, asset: CollateralAsset) {
  const mint = hasOwnFeed(asset) ? asset.mint : null;
  const scoped = useMemo(() => (config && mint ? { ...config, wsolMint: mint } : config), [config, mint]);
  return useBalances(publicKey, scoped);
}
