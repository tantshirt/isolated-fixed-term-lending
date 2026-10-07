"use client";

import Link from "next/link";
import { InvitesPanel } from "@/components/private/InvitesPanel";
import { Button } from "@/components/ui/Button";
import { formatBpsAsPercent, formatDuration, formatUsdc } from "@/lib/format";
import { addTotals, privateTotals, privateV2Totals, type PrivatePosition, type PrivateV2Position } from "@/lib/private/portfolio";
import { useV2Positions } from "@/lib/private/use-v2-positions";
import { roomV2Path } from "@/lib/private/v2-loans";
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
  const v2 = useV2Positions(status === "ready" ? er : null, wallet);

  if (!wallet) return null;
  if (status !== "ready")
    return (
      <section className={s.privateDesk} aria-labelledby="pd-h">
        <h2 id="pd-h">Private loans</h2>
        <PrivateTotalsRow locked positions={null} v2={null} />
        <p>Private amounts stay locked until you sign in privately. It asks your wallet to sign a message; nothing is sent or spent.</p>
        <Button variant="secondary" onClick={connect} loading={status === "verifying" || status === "signing"}>
          Sign in privately
        </Button>
      </section>
    );

  return (
    <section className={s.privateDesk} aria-labelledby="pd-h">
      <h2 id="pd-h">Private loans</h2>
      <PrivateTotalsRow locked={false} positions={positions} v2={v2} />
      <PrivateV2Loans positions={v2} />
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
function PrivateTotalsRow({ locked, positions, v2 }: { locked: boolean; positions: PrivatePosition[] | null; v2: PrivateV2Position[] | null }) {
  // Both room kinds must be read before a total shows; until then it is "Reading…", never a partial sum.
  const t = positions && v2 ? addTotals(privateTotals(positions), privateV2Totals(v2, Math.floor(Date.now() / 1000))) : null;
  const value = (v: bigint | undefined) => (locked ? "Locked" : t === null ? "Reading…" : `${formatUsdc(v!)} USDC`);
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

const V2_WORDS: Record<string, string> = {
  draft: "Offer being prepared",
  funded: "Offer waiting for the borrower",
  active: "Waiting for repayment",
  repaid: "Repaid",
  cancelled: "Cancelled",
  overdueLiquidated: "Settled after grace",
  pricedRecovered: "Recovered at the market price",
  terminalClaimed: "Collateral claimed",
  liquidated: "Liquidated",
};

function PrivateV2Loans({ positions }: { positions: PrivateV2Position[] | null }) {
  const shown = (positions ?? []).filter((p) => p.terms.status !== "cancelled");
  if (!shown.length) return null;
  return (
    <>
      <h3 className={s.privateSub}>Rooms with repayment rules</h3>
      <ul className={s.bids}>
        {shown.map((p) => (
          <li key={p.anchor.toBase58()} className={s.bid}>
            <div>
              <p className={s.bidLabel}>
                {p.side === "lender" ? "You lent" : "You borrowed"} · {V2_WORDS[p.terms.status] ?? p.terms.status}
              </p>
              <p className={s.bidTerms}>
                <span className="num">{formatUsdc(p.terms.terms.principal)} USDC</span> · {formatBpsAsPercent(p.terms.terms.interestBps, 2)} for{" "}
                {formatDuration(p.terms.terms.duration)}
                {p.terms.status === "active" && (
                  <>
                    {" "}· <span className="num">{formatUsdc(p.terms.ledger.outstandingPrincipal)} USDC</span> principal left
                  </>
                )}
              </p>
            </div>
            <Link className={s.inlineLink} href={roomV2Path(p.room)}>
              Open room
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
