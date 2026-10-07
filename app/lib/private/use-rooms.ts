"use client";

import type { Connection, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
import { bidState, dismissInvite, dismissedInvites, listMyRooms, listRoomLoans, newInvitations, type Bid, type MyRoom } from "./inbox";
import { privatePositions, type PrivatePosition } from "./portfolio";
import { rememberRoom, savedRooms } from "./rooms";

const EVERY_MS = 20_000;

/** The signed-in wallet's rooms, new invitations and private bids, refreshed while the tab is visible. */
export function useMyRooms(er: Connection | null, wallet: PublicKey | null, opts: { bids?: boolean } = {}) {
  const [rooms, setRooms] = useState<MyRoom[] | null>(null);
  const [bids, setBids] = useState<Bid[] | null>(null);
  const [positions, setPositions] = useState<PrivatePosition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const key = wallet?.toBase58() ?? null;

  useEffect(() => {
    setRooms(null);
    setBids(null);
    setPositions(null);
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
          // One read of every room's loans serves both the lender's bids and all private positions.
          const perRoom = await Promise.all(list.map(async (room) => ({ room, loans: await listRoomLoans(er, room.anchor) })));
          if (!alive) return;
          const mine = privatePositions(wallet, perRoom);
          const order: Record<Bid["state"], number> = { funded: 0, accepted: 1, draft: 2, settled: 3 };
          setBids(
            mine
              .filter((p) => p.side === "lender")
              .map((p) => ({ room: p.room, loan: { anchor: p.anchor, loanId: perRoom.flatMap((r) => r.loans).find((l) => l.anchor.equals(p.anchor))!.loanId, terms: p.terms }, state: bidState(p.terms) }))
              .sort((a, b) => order[a.state] - order[b.state]),
          );
          setPositions(mine);
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
  return { rooms, invitations, bids, positions, error, dismiss, accept, refresh: () => setTick((t) => t + 1) };
}
