"use client";

import Link from "next/link";
import { InvitesPanel } from "@/components/private/InvitesPanel";
import { Button } from "@/components/ui/Button";
import { formatBpsAsPercent, formatDuration, formatUsdc } from "@/lib/format";
import type { BidState } from "@/lib/private/inbox";
import { useMyRooms } from "@/lib/private/use-rooms";
import { usePrivate } from "@/lib/private/use-private";
import s from "./MyLoans.module.css";

const BID_WORDS: Record<BidState, { label: string; detail: string }> = {
  draft: { label: "Proposed", detail: "Not funded yet. Lock USDC in the room when the terms look right." },
  funded: {
    label: "Funded, waiting for the borrower",
    detail: "If the borrower takes another offer, cancel this one in the room to get your USDC back.",
  },
  accepted: { label: "Accepted", detail: "The borrower took this offer. The loan is running." },
  settled: { label: "Settled", detail: "Finished. Nothing to do." },
};

/** Private side of My loans: invitations and every bid this wallet made as a lender. */
export function PrivateDesk() {
  const { signer, er, status, connect } = usePrivate();
  const wallet = signer?.publicKey ?? null;
  const { bids, rooms } = useMyRooms(status === "ready" ? er : null, wallet, { bids: true });

  if (!wallet) return null;
  if (status !== "ready")
    return (
      <section className={s.privateDesk} aria-labelledby="pd-h">
        <h2 id="pd-h">Private rooms and bids</h2>
        <p>Sign in privately to see rooms you were invited to and every bid you made as a lender. It asks your wallet to sign a message; nothing is sent or spent.</p>
        <Button variant="secondary" onClick={connect} loading={status === "verifying" || status === "signing"}>
          Sign in privately
        </Button>
      </section>
    );

  return (
    <section className={s.privateDesk} aria-labelledby="pd-h">
      <h2 id="pd-h">Private rooms and bids</h2>
      <InvitesPanel er={er} wallet={wallet} />
      {bids === null ? (
        <p className={s.loading}>Reading your rooms…</p>
      ) : bids.length === 0 ? (
        <p>
          No private bids yet. {rooms?.length ? `You are in ${rooms.length === 1 ? "1 room" : `${rooms.length} rooms`}.` : ""}{" "}
          <Link href="/devnet/discover?side=borrowers&venue=private" className={s.inlineLink}>
            See private requests
          </Link>
        </p>
      ) : (
        <ul className={s.bids}>
          {bids.map((b) => (
            <li key={b.loan.loanId} className={s.bid} data-state={b.state}>
              <div>
                <p className={s.bidLabel}>{BID_WORDS[b.state].label}</p>
                <p className={s.bidTerms}>
                  <span className="num">{formatUsdc(b.loan.terms.principal)} USDC</span> ·{" "}
                  {formatBpsAsPercent(b.loan.terms.interestBps)} for {formatDuration(b.loan.terms.durationSeconds)} · room{" "}
                  {b.room.roomId.slice(0, 4)}
                </p>
                <p className={s.bidDetail}>{BID_WORDS[b.state].detail}</p>
              </div>
              <Link className={s.action} data-tone={b.state === "settled" ? "done" : undefined} href={`/devnet/private/rooms/${b.room.roomId}`}>
                Open room
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
