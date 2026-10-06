"use client";

import Link from "next/link";
import type { Connection, PublicKey } from "@solana/web3.js";
import { shortKey } from "@/lib/format";
import { useMyRooms } from "@/lib/private/use-rooms";
import styles from "./private.module.css";

const ROLE_WORD = { lender: "as a lender", borrower: "as the borrower", viewer: "as a viewer" } as const;

/** Rooms you were added to since you last looked, found without anyone sending a link. */
export function InvitesPanel({ er, wallet }: { er: Connection | null; wallet: PublicKey | null }) {
  const { invitations, accept, dismiss, rooms } = useMyRooms(er, wallet);
  if (!er || !wallet || !rooms || invitations.length === 0) return null;
  return (
    <section className={styles.invites} aria-labelledby="invites-h">
      <h2 id="invites-h">
        {invitations.length === 1 ? "You were invited to a room" : `You were invited to ${invitations.length} rooms`}
      </h2>
      <ul>
        {invitations.map((r) => (
          <li key={r.roomId} className={styles.invite}>
            <span>
              <strong>Room {r.roomId.slice(0, 4)}</strong> · {ROLE_WORD[r.role]} · from{" "}
              <span className={styles.mono}>{shortKey(r.state.owner.toBase58())}</span>
            </span>
            <span className={styles.inviteActions}>
              <Link className={styles.inviteOpen} href={`/devnet/private/rooms/${r.roomId}`} onClick={() => accept(r.roomId)}>
                Open room
              </Link>
              <button type="button" className={styles.inviteDismiss} onClick={() => dismiss(r.roomId)}>
                Dismiss
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
