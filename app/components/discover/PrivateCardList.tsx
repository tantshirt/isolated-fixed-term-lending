"use client";

import Link from "next/link";
import { useState } from "react";
import { TeeCard } from "@/components/private/TeeCard";
import { Button } from "@/components/ui/Button";
import { messageFromAnchorError } from "@/lib/anchor-errors";
import { formatBpsAsPercent, formatDuration, formatUsdc } from "@/lib/format";
import { SHOW, requestJoin, type Card } from "@/lib/private/discovery";
import { usePrivate } from "@/lib/private/use-private";
import styles from "@/components/private/private.module.css";
import own from "./Discover.module.css";

const NOT_SHARED = <span className={styles.notShared}>Not shared</span>;

/** Borrower cards published from private rooms. Each shows only the fields its borrower chose. */
export function PrivateCardList({ cards }: { cards: Card[] }) {
  const { signer, base, er, status, error, connect } = usePrivate();
  const [asked, setAsked] = useState<Record<string, "busy" | "done" | string>>({});
  const [wantsSignIn, setWantsSignIn] = useState(false);

  return (
    <div className={own.stack}>
      {wantsSignIn && status !== "ready" && (
        <div className={styles.narrow}>
          <TeeCard status={status} error={error} onConnect={connect} />
        </div>
      )}
      <ul className={`${styles.cards} ${own.grid}`}>
        {cards.map((c) => {
          const f = c.fields;
          const key = c.address.toBase58();
          const mine = signer && c.publisher.equals(signer.publicKey);
          return (
            <li key={key} className={styles.card}>
              <p className={styles.cardHead}>
                <span className={styles.roomGlyph} aria-hidden />
                Private request · room <span className="address">{c.room.toBase58().slice(0, 4)}</span>
              </p>
              <dl className={styles.cardFields}>
                <div>
                  <dt>Amount</dt>
                  <dd>{f.show & SHOW.amount ? <span className="num">{`${formatUsdc(f.amountMax)} USDC`}</span> : NOT_SHARED}</dd>
                </div>
                <div>
                  <dt>Interest</dt>
                  <dd>{f.show & SHOW.rate ? <span className="num">{`Up to ${formatBpsAsPercent(f.maxInterestBps)}`}</span> : NOT_SHARED}</dd>
                </div>
                <div>
                  <dt>Term</dt>
                  <dd>{f.show & SHOW.duration ? <span className="num">{formatDuration(f.durationSeconds)}</span> : NOT_SHARED}</dd>
                </div>
                <div>
                  <dt>Collateral</dt>
                  <dd>{f.show & SHOW.collateral ? f.collateralNote : NOT_SHARED}</dd>
                </div>
              </dl>
              {mine ? (
                <Link className={styles.textAccent} href="/devnet/private">
                  Your card
                </Link>
              ) : asked[key] === "done" ? (
                <p className={styles.ok}>Asked. The borrower decides whether to invite you.</p>
              ) : (
                <Button
                  variant="secondary"
                  loading={asked[key] === "busy"}
                  onClick={async () => {
                    if (!er || !signer || status !== "ready") {
                      setWantsSignIn(true);
                      return void connect();
                    }
                    setAsked((a) => ({ ...a, [key]: "busy" }));
                    try {
                      await requestJoin(base, er, signer, c.room);
                      setAsked((a) => ({ ...a, [key]: "done" }));
                    } catch (e) {
                      setAsked((a) => ({ ...a, [key]: messageFromAnchorError(e) }));
                    }
                  }}
                >
                  {status === "ready" ? "Ask to join as a lender" : "Sign in privately to ask"}
                </Button>
              )}
              {asked[key] && !["busy", "done"].includes(asked[key]) && <p className={styles.error}>{asked[key]}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
