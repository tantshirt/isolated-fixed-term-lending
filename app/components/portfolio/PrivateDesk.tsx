"use client";

import Link from "next/link";
import { InvitesPanel } from "@/components/private/InvitesPanel";
import { Button } from "@/components/ui/Button";
import { formatBpsAsPercent, formatDuration, formatUsdc } from "@/lib/format";
import { privateTotals, type PrivatePosition } from "@/lib/private/portfolio";
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
  const { bids, rooms, positions } = useMyRooms(status === "ready" ? er : null, wallet, { bids: true });

  if (!wallet) return null;
  if (status !== "ready")
    return (
      <section className={s.privateDesk} aria-labelledby="pd-h">
        <h2 id="pd-h">Private loans</h2>
        <PrivateTotalsRow positions={null} />
        <p>Private amounts stay locked until you sign in privately. It asks your wallet to sign a message; nothing is sent or spent.</p>
        <Button variant="secondary" onClick={connect} loading={status === "verifying" || status === "signing"}>
          Sign in privately
        </Button>
      </section>
    );

  return (
    <section className={s.privateDesk} aria-labelledby="pd-h">
      <h2 id="pd-h">Private loans</h2>
      <PrivateTotalsRow positions={positions} />
      <InvitesPanel er={er} wallet={wallet} />
      <PrivateBorrowing positions={positions} />
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

/** Private totals sit apart from public ones. Unknown is "Locked" or "Reading", never zero. */
function PrivateTotalsRow({ positions }: { positions: PrivatePosition[] | null }) {
  const t = positions ? privateTotals(positions) : null;
  const value = (v: bigint | undefined) => (positions === null ? "Locked" : t ? `${formatUsdc(v!)} USDC` : "Reading…");
  return (
    <dl className={s.privateTotals} aria-label="Private totals">
      <div>
        <dt>Lent out</dt>
        <dd className="num">{value(t?.lentOut)}</dd>
      </div>
      <div>
        <dt>Owed to you</dt>
        <dd className="num">{value(t?.owedToYou)}</dd>
      </div>
      <div>
        <dt>Borrowed</dt>
        <dd className="num">{value(t?.borrowed)}</dd>
      </div>
      <div>
        <dt>You owe</dt>
        <dd className="num">{value(t?.youOwe)}</dd>
      </div>
    </dl>
  );
}

function PrivateBorrowing({ positions }: { positions: PrivatePosition[] | null }) {
  const mine = (positions ?? []).filter((p) => p.side === "borrower" && p.terms.status !== "cancelled" && p.terms.status !== "draft");
  if (!mine.length) return null;
  return (
    <>
      <h3 className={s.privateSub}>Your private borrowing</h3>
      <ul className={s.bids}>
        {mine.map((p) => (
          <li key={p.anchor.toBase58()} className={s.bid} data-state={p.state}>
            <div>
              <p className={s.bidLabel}>
                {p.terms.status === "funded" ? "Offer waiting for you" : p.terms.status === "active" ? "Waiting for repayment" : "Settled"}
              </p>
              <p className={s.bidTerms}>
                <span className="num">{formatUsdc(p.terms.principal)} USDC</span> · {formatBpsAsPercent(p.terms.interestBps, 2)} for {formatDuration(p.terms.durationSeconds)}
              </p>
            </div>
            <Link className={s.inlineLink} href={`/devnet/private/rooms/${p.room.roomId}`}>
              Open room
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
