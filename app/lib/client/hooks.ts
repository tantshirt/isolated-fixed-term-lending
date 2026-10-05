"use client";

import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAllOffers, fetchOfferByKey, type Offer } from "@/lib/offers";
import { getConnection } from "@/lib/program";
import type { PriceSnapshot } from "@/lib/offer-status";
import { sharedRead } from "../shared-read";
import { readChainClock } from "./chain-clock";
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
    let alive = true,
      running = false;
    const tick = async () => {
      if (!alive || running || document.visibilityState !== "visible") return;
      running = true;
      try {
        await saved.current();
      } finally {
        running = false;
      }
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
  const [responseKey, setResponseKey] = useState<number | null>(null);
  const [localControls, setLocalControls] = useState(false);
  const [readiness, setReadiness] = useState<{
    ready: boolean;
    errors: string[];
  } | null>(null);
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setConfig(null);
    setReadiness(null);
    setLocalControls(false);
    sharedRead(
      `config:${refreshKey}`,
      () =>
        fetch("/api/config").then((r) => {
          if (!r.ok) throw new Error("Configuration unavailable");
          return r.json();
        }),
      10_000
    )
      .then(
        (j: {
          config: DevConfig | null;
          readiness: { ready: boolean; errors: string[] };
          localControls?: boolean;
        }) => {
          if (alive) {
            setConfig(j.config);
            setReadiness(j.readiness);
            setLocalControls(j.localControls === true);
          }
        }
      )
      .catch(() => {
        if (alive) {
          setConfig(null);
          setReadiness(null);
          setLocalControls(false);
        }
      })
      .finally(() => {
        if (alive) {
          setLoaded(true);
          setResponseKey(refreshKey);
        }
      });
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  const current = responseKey === refreshKey;
  return {
    config: current ? config : null,
    loaded: current && loaded,
    readiness: current ? readiness : null,
    localControls: current && loaded && localControls,
  };
}

export type LivePrice = PriceSnapshot & {
  chainTime: number;
  receivedAt: number;
};

/**
 * SOL/USD from the price account, judged fresh on the chain clock.
 * Locally the mock is re-stamped so a demo never sits on a stale price.
 */
export function usePrice(ms = 10_000) {
  const { refreshKey } = useSigner();
  const [price, setPrice] = useState<LivePrice | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePoll(
    async () => {
      try {
        const j = await sharedRead(`price:${refreshKey}`, async () => {
          const r = await fetch("/api/price?keepFresh=1", {
            cache: "no-store",
          });
          const data = await r.json();
          if (!r.ok)
            throw new Error(
              r.status === 503
                ? "Devnet rate limit: live price checks will resume shortly."
                : data.error ?? "No price"
            );
          return data;
        });
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
        setPrice(null);
        setError(e instanceof Error ? e.message : "No price");
      }
    },
    ms,
    [refreshKey]
  );
  return { price, error };
}

/** Last observed chain time, independent of oracle availability. Unknown disables time-sensitive actions. */
export function useChainNow(): number | null {
  const { refreshKey } = useSigner();
  const [snapshot, setSnapshot] = useState<{
    key: number;
    time: number | null;
  } | null>(null);
  useEffect(() => {
    let alive = true,
      request = 0;
    setSnapshot(null);
    const tick = async () => {
      const ownRequest = ++request;
      if (document.visibilityState !== "visible") {
        setSnapshot(null);
        return;
      }
      try {
        const time = await sharedRead(`clock:${refreshKey}`, () =>
          readChainClock(getConnection())
        );
        if (alive && ownRequest === request)
          setSnapshot({ key: refreshKey, time });
      } catch {
        if (alive && ownRequest === request)
          setSnapshot({ key: refreshKey, time: null });
      }
    };
    void tick();
    const id = setInterval(tick, 10_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refreshKey]);
  return snapshot?.key === refreshKey ? snapshot.time : null;
}

export function useOffers(ms = 15_000) {
  const { refreshKey } = useSigner();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePoll(
    async () => {
      try {
        setOffers(
          await sharedRead(`offers:${refreshKey}`, () =>
            fetchAllOffers(getConnection())
          )
        );
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not read offers");
      }
    },
    ms,
    [refreshKey]
  );
  return { offers, error };
}

export function useOffer(key: string, ms = 10_000) {
  const { refreshKey } = useSigner();
  const [retry, setRetry] = useState(0);
  const identity = key;
  const [snapshot, setSnapshot] = useState<{
    identity: string;
    offer: Offer | null | undefined;
    error: string | null;
  } | null>(null);
  const reload = useCallback(() => setRetry((n) => n + 1), []);
  useEffect(() => {
    let alive = true,
      request = 0;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const ownRequest = ++request;
      try {
        const offer = await sharedRead(
          `offer:${key}:${refreshKey}:${retry}`,
          () => fetchOfferByKey(getConnection(), new PublicKey(key))
        );
        if (alive && ownRequest === request)
          setSnapshot({ identity, offer, error: null });
      } catch (e) {
        if (alive && ownRequest === request)
          setSnapshot({
            identity,
            offer: undefined,
            error: e instanceof Error ? e.message : "Could not read offer",
          });
      }
    };
    void load();
    const id = setInterval(load, ms);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", load);
    };
  }, [key, identity, refreshKey, retry, ms]);
  return {
    offer: snapshot?.identity === identity ? snapshot.offer : undefined,
    error: snapshot?.identity === identity ? snapshot.error : null,
    reload,
  };
}

export type Balances = { sol: number; usdc: bigint; wsol: bigint };

export function useBalances(
  publicKey: PublicKey | null,
  config: DevConfig | null,
  ms = 15_000
) {
  const { refreshKey } = useSigner();
  const key = publicKey?.toBase58() ?? null;
  const usdcMint = config?.usdcMint,
    wsolMint = config?.wsolMint;
  const identity = `${key}:${usdcMint}:${wsolMint}:${refreshKey}`;
  const [snapshot, setSnapshot] = useState<{
    identity: string;
    balances: Balances | null;
  } | null>(null);
  useEffect(() => {
    let alive = true,
      request = 0;
    setSnapshot(null);
    const load = async () => {
      const ownRequest = ++request;
      if (!key || !usdcMint || !wsolMint) return;
      if (document.visibilityState !== "visible") return;
      const owner = new PublicKey(key),
        c = getConnection();
      try {
        const token = async (mint: string) => {
          const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner);
          if (!(await c.getAccountInfo(ata))) return 0n;
          return BigInt((await c.getTokenAccountBalance(ata)).value.amount);
        };
        const [lamports, usdc, wsol] = await sharedRead(
          `balances:${identity}`,
          () =>
            Promise.all([c.getBalance(owner), token(usdcMint), token(wsolMint)])
        );
        if (alive && ownRequest === request)
          setSnapshot({
            identity,
            balances: { sol: lamports / 1e9, usdc, wsol },
          });
      } catch {
        if (alive && ownRequest === request)
          setSnapshot({ identity, balances: null });
      }
    };
    void load();
    const id = setInterval(load, ms);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", load);
    };
  }, [key, usdcMint, wsolMint, refreshKey, identity, ms]);
  return snapshot?.identity === identity ? snapshot.balances : null;
}
