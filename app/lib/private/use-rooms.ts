"use client";

import type { Connection, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
import { dismissInvite, dismissedInvites, listMyBids, listMyRooms, newInvitations, type Bid, type MyRoom } from "./inbox";
import { rememberRoom, savedRooms } from "./rooms";

const EVERY_MS = 20_000;

/** The signed-in wallet's rooms, new invitations and private bids, refreshed while the tab is visible. */
export function useMyRooms(er: Connection | null, wallet: PublicKey | null, opts: { bids?: boolean } = {}) {
  const [rooms, setRooms] = useState<MyRoom[] | null>(null);
  const [bids, setBids] = useState<Bid[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const key = wallet?.toBase58() ?? null;

  useEffect(() => {
    setRooms(null);
    setBids(null);
  }, [key]);

  useEffect(() => {
    if (!er || !wallet) return;
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const list = await listMyRooms(er, wallet);
        if (!alive) return;
        setRooms(list);
        setError(null);
        if (opts.bids) {
          const b = await listMyBids(er, wallet, list);
          if (alive) setBids(b);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Could not read your rooms");
      }
    };
    void load();
    const id = setInterval(load, EVERY_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", load);
    };
  }, [er, wallet, opts.bids, tick]);

  const invitations = rooms && key ? newInvitations(rooms, savedRooms(key), dismissedInvites(key)) : [];
  const dismiss = useCallback(
    (roomId: string) => {
      if (!key) return;
      dismissInvite(key, roomId);
      setTick((t) => t + 1);
    },
    [key]
  );
  const accept = useCallback(
    (roomId: string) => {
      if (key) rememberRoom(key, roomId);
    },
    [key]
  );
  return { rooms, invitations, bids, error, dismiss, accept, refresh: () => setTick((t) => t + 1) };
}
