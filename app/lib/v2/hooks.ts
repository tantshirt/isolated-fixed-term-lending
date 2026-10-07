"use client";

import { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
import { useSigner } from "../client/signer-context";
import { getConnection } from "../program";
import { sharedRead } from "../shared-read";
import { fetchOfferV2, fetchOffersV2, type OfferV2 } from "./offers";

/** One V2 loan, polled while the tab is visible. `null` means the account is closed. */
export function useOfferV2(key: string, ms = 10_000) {
  const { refreshKey } = useSigner();
  const [retry, setRetry] = useState(0);
  const [snap, setSnap] = useState<{ key: string; offer: OfferV2 | null | undefined; error: string | null } | null>(null);
  const reload = useCallback(() => setRetry((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    let request = 0;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const own = ++request;
      try {
        const offer = await sharedRead(`offer-v2:${key}:${refreshKey}:${retry}`, () => fetchOfferV2(getConnection(), new PublicKey(key)));
        if (alive && own === request) setSnap({ key, offer, error: null });
      } catch (e) {
        if (alive && own === request) setSnap({ key, offer: undefined, error: e instanceof Error ? e.message : "Could not read this loan" });
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
  }, [key, refreshKey, retry, ms]);
  return { offer: snap?.key === key ? snap.offer : undefined, error: snap?.key === key ? snap.error : null, reload };
}

/** Every V2 offer (for the offers list) or one wallet's side (for My loans). */
export function useOffersV2(enabled: boolean, wallet?: string | null, ms = 20_000) {
  const { refreshKey } = useSigner();
  const [rows, setRows] = useState<OfferV2[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const c = getConnection();
        const found = wallet
          ? (
              await Promise.all([
                sharedRead(`v2-lender:${wallet}:${refreshKey}`, () => fetchOffersV2(c, { side: "currentLender", wallet })),
                sharedRead(`v2-borrower:${wallet}:${refreshKey}`, () => fetchOffersV2(c, { side: "borrower", wallet })),
              ])
            ).flat()
          : await sharedRead(`v2-all:${refreshKey}`, () => fetchOffersV2(c));
        const unique = [...new Map(found.map((o) => [o.publicKey, o])).values()];
        if (alive) setRows(unique);
      } catch {
        // Keep the last good list; the next poll retries.
      }
    };
    void load();
    const id = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled, wallet, refreshKey, ms]);
  return rows;
}

/** Open V2 borrower requests, for Discover. */
export function useRequestsV2(enabled: boolean, ms = 20_000, wallet?: string | null) {
  const { refreshKey } = useSigner();
  const [rows, setRows] = useState<import("./offers").RequestV2[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const { fetchRequestsV2 } = await import("./offers");
        const found = await sharedRead(`v2-requests:${wallet ?? "all"}:${refreshKey}`, () => fetchRequestsV2(getConnection(), wallet ?? undefined));
        if (alive) setRows(found);
      } catch {
        // Keep the last good list.
      }
    };
    void load();
    const id = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled, wallet, refreshKey, ms]);
  return rows;
}
