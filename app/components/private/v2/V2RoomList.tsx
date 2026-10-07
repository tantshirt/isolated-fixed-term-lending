"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Connection } from "@solana/web3.js";
import { Button } from "@/components/ui/Button";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { shortKey } from "@/lib/format";
import { PRIVATE_V2_LIVE, ROLE_V2 } from "@/lib/private/v2-codec";
import { openRoomV2, roomV2Path, roomV2Ref, savedRoomsV2 } from "@/lib/private/v2-loans";
import styles from "../private.module.css";
import s from "../desk/Desk.module.css";

/** Rooms with repayment rules this wallet opened or joined, from ids kept in this browser. */
export function V2RoomList({ signer, base, er, ready }: { signer: LoanSigner | null; base: Connection | null; er: Connection | null; ready: boolean }) {
  const router = useRouter();
  const wallet = signer?.publicKey.toBase58() ?? null;
  const [rooms, setRooms] = useState<{ creator: string; roomId: string }[]>([]);
  const [lend, setLend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setRooms(wallet ? savedRoomsV2(wallet) : []), [wallet]);

  if (!PRIVATE_V2_LIVE) return null;
  return (
    <div className={s.deskIndex}>
      {rooms.length === 0 ? (
        <p className={styles.hint}>{ready ? "No rooms with repayment rules yet." : "Sign in privately to see your rooms."}</p>
      ) : (
        <ul className={s.deskLinks}>
          {rooms.map((r) => (
            <li key={r.roomId}>
              <Link href={roomV2Path(r)}>
                Room <span className="mono">{shortKey(roomV2Ref(r.creator, r.roomId).anchor.toBase58())}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {ready && signer && base && er && (
        <>
          <label className={s.check}>
            <input type="checkbox" checked={lend} onChange={(e) => setLend(e.target.checked)} /> I will lend in this room
          </label>
          <p className={styles.hint}>Your wallet signs to create it. You can invite borrowers and lenders after.</p>
          <Button
            variant="secondary"
            block
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const r = await openRoomV2(base, er, signer, lend ? ROLE_V2.lender : ROLE_V2.viewer);
                router.push(roomV2Path(r));
              } catch (e) {
                setErr(e instanceof Error ? e.message : "The room could not be created.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Create a room with repayment rules
          </Button>
        </>
      )}
      {err && (
        <p role="alert" className={styles.error}>
          {err}
        </p>
      )}
    </div>
  );
}
