"use client";

import type { Connection, PublicKey } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { privateV2Positions, type PrivateV2Position } from "./portfolio";
import { readRoomV2, roomV2Ref, savedRoomsV2 } from "./v2-loans";
import { PRIVATE_V2_LIVE } from "./v2-codec";

const EVERY_MS = 20_000;

/** This wallet's loans in V2 rooms it remembers, read through the TEE with its own token. Null while reading. */
export function useV2Positions(er: Connection | null, wallet: PublicKey | null) {
  const [positions, setPositions] = useState<PrivateV2Position[] | null>(null);
  const key = wallet?.toBase58() ?? null;
  useEffect(() => setPositions(null), [key]);
  useEffect(() => {
    if (!er || !wallet) return;
    if (!PRIVATE_V2_LIVE) {
      setPositions([]);
      return;
    }
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const rooms = savedRoomsV2(wallet.toBase58());
        const read = await Promise.all(
          rooms.map(async (room) => {
            const r = await readRoomV2(er, roomV2Ref(room.creator, room.roomId).anchor);
            return { room, loans: r.access === "member" ? r.loans : [] };
          }),
        );
        if (alive) setPositions(privateV2Positions(wallet, read));
      } catch {
        // Keep the last good read; a failed refresh never shows zero.
      }
    };
    void load();
    const id = setInterval(load, EVERY_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [er, wallet]);
  return positions;
}
