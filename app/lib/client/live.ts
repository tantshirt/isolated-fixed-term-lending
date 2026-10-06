"use client";

import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { useEffect, useMemo, useRef, useState } from "react";
import idl from "@/idl/isolated_loan.json";
import privateIdl from "@/idl/private_loan.json";
import { PROGRAM_ID } from "@/lib/constants";
import { decodeOffer, fetchAllOffers, type Offer } from "@/lib/offers";
import { decodeRequest, fetchAllRequests, fetchRequestByKey, byNewest, type LoanRequest } from "@/lib/requests";
import { decodeCard, listCards, type Card } from "@/lib/private/discovery";
import { PRIVATE_PROGRAM_ID } from "@/lib/private/room-codec";
import { getConnection } from "@/lib/program";
import {
  HEARTBEAT_TIMEOUT_MS,
  POLL_MS,
  RECONCILE_MS,
  liveStatus,
  upsert,
  type LiveStatus,
} from "@/lib/live-state";
import { sharedRead } from "../shared-read";
import { fetchOffersBy, fetchRequestsBy } from "@/lib/portfolio";
import { useSigner } from "./signer-context";

type Spec<T> = {
  name: string;
  programId: PublicKey;
  discriminator: number[];
  load: (c: Connection) => Promise<T[]>;
  decode: (c: Connection, key: PublicKey, data: Buffer) => T | null;
  keyOf: (t: T) => string;
  sort?: (a: T, b: T) => number;
};

const discriminator = (source: { accounts?: { name: string; discriminator: number[] }[] }, name: string) =>
  source.accounts!.find((a) => a.name === name)!.discriminator;

// One slot subscription is shared by every list on the page.
let beatSubscribers = 0;
let beatId: number | null = null;
let lastBeat: number | null = null;
function watchSlots(c: Connection) {
  beatSubscribers++;
  if (beatId === null) beatId = c.onSlotChange(() => (lastBeat = Date.now()));
  return () => {
    if (--beatSubscribers === 0 && beatId !== null) {
      void c.removeSlotChangeListener(beatId).catch(() => {});
      beatId = null;
      lastBeat = null;
    }
  };
}

/**
 * A program-account list kept current by websocket notifications. A slot heartbeat
 * tells whether the socket is alive; when it is not, the list polls instead.
 */
function useLiveAccounts<T>(spec: Spec<T>) {
  const { refreshKey } = useSigner();
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;
  const loadedName = useRef(spec.name);

  useEffect(() => {
    const c = getConnection();
    const s = specRef.current;
    // Another wallet's list must never show while this one loads.
    if (loadedName.current !== s.name) {
      loadedName.current = s.name;
      setItems(null);
      setError(null);
    }
    let alive = true;
    let subscribed = false;
    let lastLoadOk: boolean | null = null;
    let lastLoad = 0;

    const load = async () => {
      if (!alive || document.visibilityState !== "visible") return;
      lastLoad = Date.now();
      try {
        const rows = await sharedRead(`live:${s.name}:${refreshKey}:${Math.floor(lastLoad / 5_000)}`, () => s.load(c), 5_000);
        if (!alive) return;
        setItems(rows);
        setError(null);
        setUpdatedAt(Date.now());
        lastLoadOk = true;
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Could not read Devnet");
        lastLoadOk = false;
      }
    };

    let subId: number | null = null;
    try {
      subId = c.onProgramAccountChange(
        s.programId,
        ({ accountId, accountInfo }) => {
          if (!alive) return;
          lastBeat = Date.now();
          const item = s.decode(c, accountId, accountInfo.data);
          setItems((list) => upsert(list, accountId.toBase58(), item, s.keyOf, s.sort));
          setUpdatedAt(Date.now());
        },
        { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(Uint8Array.from(s.discriminator)) } }] }
      );
      subscribed = true;
    } catch {
      subscribed = false;
    }
    const stopBeat = watchSlots(c);

    void load();
    const tick = setInterval(() => {
      const now = Date.now();
      const next = liveStatus({ now, lastBeat, subscribed, lastLoadOk });
      setStatus(next);
      // Live: reconcile closes and missed notifications slowly. Otherwise poll.
      const every = next === "live" ? RECONCILE_MS : POLL_MS;
      if (now - lastLoad >= every) void load();
    }, 1_000);
    document.addEventListener("visibilitychange", load);

    return () => {
      alive = false;
      clearInterval(tick);
      document.removeEventListener("visibilitychange", load);
      stopBeat();
      if (subId !== null) void c.removeProgramAccountChangeListener(subId).catch(() => {});
    };
    // A new spec name (another wallet) is a new list.
  }, [refreshKey, spec.name]);

  return { items, error, status, updatedAt };
}

export { HEARTBEAT_TIMEOUT_MS };
export type { LiveStatus };

const OFFER_SPEC: Spec<Offer> = {
  name: "offers",
  programId: PROGRAM_ID,
  discriminator: discriminator(idl, "Offer"),
  load: fetchAllOffers,
  decode: decodeOffer,
  keyOf: (o) => o.publicKey,
  sort: (a, b) => Number(b.startTs || 0) - Number(a.startTs || 0),
};

const REQUEST_SPEC: Spec<LoanRequest> = {
  name: "requests",
  programId: PROGRAM_ID,
  discriminator: discriminator(idl, "LoanRequest"),
  load: fetchAllRequests,
  decode: decodeRequest,
  keyOf: (r) => r.publicKey,
  sort: byNewest,
};

const CARD_SPEC: Spec<Card> = {
  name: "cards",
  programId: PRIVATE_PROGRAM_ID,
  discriminator: discriminator(privateIdl, "DiscoveryCard"),
  load: listCards,
  decode: decodeCard,
  keyOf: (c) => c.address.toBase58(),
};

export const useLiveOffers = () => useLiveAccounts(OFFER_SPEC);

/**
 * Only the offers and requests `wallet` is part of, read with account filters and
 * kept current by the same subscription as the full lists.
 */
export function useMyAccounts(wallet: string | null) {
  const offerSpec = useMemo<Spec<Offer>>(
    () => ({
      ...OFFER_SPEC,
      name: `mine-offers:${wallet ?? "none"}`,
      load: async (c) => {
        if (!wallet) return [];
        const [l, b] = await Promise.all([fetchOffersBy(c, "lender", wallet), fetchOffersBy(c, "borrower", wallet)]);
        return [...new Map([...l, ...b].map((o) => [o.publicKey, o])).values()];
      },
      decode: (c, key, data) => {
        const o = OFFER_SPEC.decode(c, key, data);
        return o && wallet && (o.lender === wallet || o.borrower === wallet) ? o : null;
      },
    }),
    [wallet]
  );
  const requestSpec = useMemo<Spec<LoanRequest>>(
    () => ({
      ...REQUEST_SPEC,
      name: `mine-requests:${wallet ?? "none"}`,
      load: async (c) => (wallet ? fetchRequestsBy(c, "borrower", wallet) : []),
      decode: (c, key, data) => {
        const r = REQUEST_SPEC.decode(c, key, data);
        return r && wallet && r.borrower === wallet ? r : null;
      },
    }),
    [wallet]
  );
  const offers = useLiveAccounts(offerSpec);
  const requests = useLiveAccounts(requestSpec);
  return {
    offers: offers.items,
    requests: requests.items,
    error: offers.error ?? requests.error,
    status: offers.status,
    loading: offers.items === null || requests.items === null,
  };
}
export const useLiveRequests = () => useLiveAccounts(REQUEST_SPEC);
export const useLiveCards = () => useLiveAccounts(CARD_SPEC);

/**
 * One request, refreshed on every change to its account and every 10 s.
 * `undefined` while loading, `null` once closed.
 */
export function useRequest(key: string | null) {
  const { refreshKey } = useSigner();
  const [state, setState] = useState<{ key: string | null; request: LoanRequest | null | undefined; error: string | null }>({
    key: null,
    request: undefined,
    error: null,
  });
  useEffect(() => {
    if (!key) return;
    const c = getConnection();
    const pk = new PublicKey(key);
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const request = await sharedRead(`request:${key}:${refreshKey}:${Math.floor(Date.now() / 3_000)}`, () =>
          fetchRequestByKey(c, pk)
        );
        if (alive) setState({ key, request, error: null });
      } catch (e) {
        if (alive) setState((s) => ({ key, request: s.key === key ? s.request : undefined, error: e instanceof Error ? e.message : "Could not read request" }));
      }
    };
    let sub: number | null = null;
    try {
      sub = c.onAccountChange(pk, () => void load(), "confirmed");
    } catch {
      sub = null;
    }
    void load();
    const id = setInterval(load, 10_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", load);
      if (sub !== null) void c.removeAccountChangeListener(sub).catch(() => {});
    };
  }, [key, refreshKey]);
  return state.key === key ? state : { key, request: undefined, error: null };
}
