"use client";

import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAllOffers, fetchOfferByKey, type Offer } from "@/lib/offers";
import { getConnection } from "@/lib/program";
import type { PriceSnapshot } from "@/lib/offer-status";
import { useSigner } from "./signer-context";

export type DevConfig = {
  usdcMint: string;
  wsolMint: string;
  priceUpdateAccount: string;
};

/** Re-runs `fn` every `ms` while the tab is visible. */
function usePoll(fn: () => Promise<void>, ms: number, deps: unknown[]) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive && document.visibilityState === "visible") void saved.current();
    };
    tick();
    const id = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

export function useDevConfig() {
  const { refreshKey } = useSigner();
  const [config, setConfig] = useState<DevConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/config")
      .then((r) => r.json())
      .then((j: { config: DevConfig | null }) => alive && setConfig(j.config))
      .catch(() => alive && setConfig(null))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return { config, loaded };
}

export type LivePrice = PriceSnapshot & { chainTime: number; receivedAt: number };

/**
 * SOL/USD from the price account, judged fresh on the chain clock.
 * Locally the mock is re-stamped so a demo never sits on a stale price.
 */
export function usePrice(ms = 5_000) {
  const { refreshKey } = useSigner();
  const [price, setPrice] = useState<LivePrice | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePoll(
    async () => {
      try {
        const r = await fetch("/api/price?keepFresh=1", { cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "No price");
        setPrice({
          price: BigInt(j.price),
          conf: BigInt(j.conf),
          exponent: j.exponent,
          publishTime: j.publishTime,
          fresh: j.fresh,
          chainTime: j.chainTime,
          receivedAt: Date.now(),
        });
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "No price");
      }
    },
    ms,
    [refreshKey],
  );
  return { price, error };
}

/** Chain time now, ticking each second from the last price read. */
export function useChainNow(price: LivePrice | null): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => clearInterval(id);
  }, []);
  if (!price) return Math.floor(Date.now() / 1000);
  return price.chainTime + Math.floor((Date.now() - price.receivedAt) / 1000);
}

export function useOffers(ms = 6_000) {
  const { refreshKey } = useSigner();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePoll(
    async () => {
      try {
        setOffers(await fetchAllOffers(getConnection()));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not read offers");
        setOffers((prev) => prev ?? []);
      }
    },
    ms,
    [refreshKey],
  );
  return { offers, error };
}

export function useOffer(key: string, ms = 3_000) {
  const { refreshKey } = useSigner();
  const [offer, setOffer] = useState<Offer | null | undefined>(undefined);
  const load = useCallback(async () => {
    try {
      setOffer(await fetchOfferByKey(getConnection(), new PublicKey(key)));
    } catch {
      setOffer(null);
    }
  }, [key]);
  usePoll(load, ms, [key, refreshKey]);
  return { offer, reload: load };
}

export type Balances = { sol: number; usdc: bigint; wsol: bigint };

export function useBalances(publicKey: PublicKey | null, config: DevConfig | null, ms = 6_000) {
  const { refreshKey } = useSigner();
  const [balances, setBalances] = useState<Balances | null>(null);
  const key = publicKey?.toBase58() ?? null;
  usePoll(
    async () => {
      if (!publicKey || !config) {
        setBalances(null);
        return;
      }
      const c = getConnection();
      const token = async (mint: string) => {
        try {
          const ata = getAssociatedTokenAddressSync(new PublicKey(mint), publicKey);
          const b = await c.getTokenAccountBalance(ata);
          return BigInt(b.value.amount);
        } catch {
          return 0n;
        }
      };
      const [lamports, usdc, wsol] = await Promise.all([
        c.getBalance(publicKey).catch(() => 0),
        token(config.usdcMint),
        token(config.wsolMint),
      ]);
      setBalances({ sol: lamports / 1e9, usdc, wsol });
    },
    ms,
    [key, config?.usdcMint, refreshKey],
  );
  return balances;
}
