"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { openRoom, savedRooms } from "@/lib/private/rooms";
import { readJoinQueue } from "@/lib/private/discovery";
import { useMyRooms } from "@/lib/private/use-rooms";
import type { Connection } from "@solana/web3.js";
import styles from "./private.module.css";

export function RoomList({
  signer,
  base,
  er,
  onChange,
}: {
  signer: LoanSigner | null;
  base: Connection;
  er: Connection | null;
  onChange: () => void;
}) {
  const wallet = signer?.publicKey.toBase58() ?? null;
  const [rooms, setRooms] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setRooms(wallet ? savedRooms(wallet) : []), [wallet]);
  // Rooms found through the rollup work on any device; saved ids cover rooms still being set up.
  const { rooms: listed, error: readError, refresh: retry } = useMyRooms(er, signer?.publicKey ?? null);
  const [requests, setRequests] = useState<Record<string, number | "unavailable">>({});
  useEffect(() => {
    let alive = true;
    setRequests({});
    if (er && listed) void Promise.all(listed.filter((r) => r.owner).map(async (r) => {
      try {
        const queue = await readJoinQueue(er, r.anchor);
        let hidden: string[] = [];
        try { hidden = JSON.parse(localStorage.getItem(`zenlo:join-dismissed:${r.anchor.toBase58()}`) ?? "[]"); } catch {}
        return [r.roomId, (queue ?? []).filter((q) => !r.state.members.some((m) => m.pubkey.equals(q.wallet)) && !hidden.includes(q.wallet.toBase58())).length] as const;
      } catch { return [r.roomId, "unavailable"] as const; }
    })).then((entries) => { if (alive) setRequests(Object.fromEntries(entries)); });
    return () => { alive = false; };
  }, [er, listed]);
  const roles = new Map((listed ?? []).map((r) => [r.roomId, r.owner ? "Owner" : r.role === "lender" ? "Lender" : r.role === "borrower" ? "Borrower" : "Viewer"]));
  const ids = [...new Set([...(listed ?? []).map((r) => r.roomId), ...rooms])];

  async function create() {
    if (!signer || !er) return;
    setBusy(true);
    setError(null);
    try {
      const room = await openRoom(base, er, signer);
      setRooms(savedRooms(signer.publicKey.toBase58()));
      onChange();
      window.location.assign(`/devnet/private/rooms/${room.roomId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panelBody}>
      {readError && <p role="alert" className={styles.error}>Your rooms could not be refreshed. Saved links may no longer be accessible. <button type="button" className={styles.textButton} onClick={retry}>Retry rooms</button></p>}
      {!listed && !readError && <p role="status" className={styles.muted}>Checking your rooms and invitations…</p>}
      {ids.length ? (
        <ul className={styles.roomList}>
          {ids.map((id) => (
            <li key={id}>
              <Link href={`/devnet/private/rooms/${id}`} className={styles.roomLink}>
                <span className={styles.roomGlyph} aria-hidden />
                <span>
                  <span className={styles.roomName}>
                    Room {id.slice(0, 4)}
                    {roles.get(id) ? <span className={styles.roleTag}>{roles.get(id)}</span> : listed ? <span className={styles.roleTag}>Not set up</span> : null}
                  </span>
                  <span className={`${styles.mono} ${styles.roomId}`}>{id.slice(0, 10)}…</span>
                  <span className={styles.hint}>{requests[id] === "unavailable" ? "Join requests unavailable · open room to retry" : typeof requests[id] === "number" && requests[id] > 0 ? `${requests[id]} join requests · review in room` : "Open conversation and proposals"}</span>
                </span>
                <span aria-hidden className={styles.chevron}>›</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>
          A room is where a borrower and the lenders they invite talk and agree on terms. Only invited wallets can read it.
        </p>
      )}
      <div className={styles.actions}>
        <Button onClick={create} loading={busy} disabled={!er}>
          Open a private room
        </Button>
        <span className={styles.hint}>Open a room to see its conversation, proposals and join requests. About 0.025 SOL: account rent plus 0.02 SOL that pays for the room&apos;s private records.</span>
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
