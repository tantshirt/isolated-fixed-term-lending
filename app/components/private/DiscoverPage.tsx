"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SHOW, listCards, requestJoin, type Card } from "@/lib/private/discovery";
import { usePrivate } from "@/lib/private/use-private";
import { TeeCard } from "./TeeCard";
import styles from "./private.module.css";

const NOT_SHARED = <span className={styles.notShared}>Not shared</span>;

const days = (s: number) => (s >= 86_400 ? `${Math.round(s / 86_400)} days` : `${Math.round(s / 3600)} hours`);

export function DiscoverPage() {
  const { signer, base, er, status, error, connect } = usePrivate();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState<Record<string, "busy" | "done" | string>>({});
  useEffect(() => {
    listCards(base).then(setCards).catch(() => setFailed(true));
  }, [base]);

  return (
    <div className="page">
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link href="/devnet/private">Private</Link>
        <span aria-hidden>/</span>
        <span>Discover</span>
      </nav>
      <header className={styles.hero}>
        <h1 className={styles.title}>Borrowers looking for lenders</h1>
        <p className={styles.lede}>
          These cards are public on purpose: each borrower chose which fields to show. Everything else, including who else is
          offering and on what terms, stays inside their private room.
        </p>
      </header>
      {status !== "ready" && (
        <div className={styles.narrow}>
          <TeeCard status={status} error={error} onConnect={connect} />
        </div>
      )}
      {failed ? (
        <p role="alert" className={styles.error}>
          Could not load cards from Devnet. Try again shortly.
        </p>
      ) : cards === null ? (
        <p className={styles.muted} aria-busy>
          Loading cards…
        </p>
      ) : cards.length === 0 ? (
        <p className={styles.muted}>No cards yet. Borrowers can publish one from their room.</p>
      ) : (
        <ul className={styles.cards}>
          {cards.map((c) => {
            const f = c.fields;
            const key = c.address.toBase58();
            const mine = signer && c.publisher.equals(signer.publicKey);
            return (
              <li key={key} className={styles.card}>
                <p className={styles.cardHead}>
                  <span className={styles.roomGlyph} aria-hidden />
                  Borrower request · room {c.room.toBase58().slice(0, 4)}
                </p>
                <dl className={styles.cardFields}>
                  <div>
                    <dt>Amount</dt>
                    <dd className="num">{f.show & SHOW.amount ? `${Number(f.amountMax) / 1e6} USDC` : NOT_SHARED}</dd>
                  </div>
                  <div>
                    <dt>Interest</dt>
                    <dd className="num">{f.show & SHOW.rate ? `Up to ${f.maxInterestBps / 100}%` : NOT_SHARED}</dd>
                  </div>
                  <div>
                    <dt>Term</dt>
                    <dd className="num">{f.show & SHOW.duration ? days(f.durationSeconds) : NOT_SHARED}</dd>
                  </div>
                  <div>
                    <dt>Collateral</dt>
                    <dd>{f.show & SHOW.collateral ? f.collateralNote : NOT_SHARED}</dd>
                  </div>
                </dl>
                {mine ? (
                  <Link className={styles.textAccent} href={`/devnet/private`}>
                    Your card
                  </Link>
                ) : asked[key] === "done" ? (
                  <p className={styles.ok}>Asked. The borrower decides whether to invite you.</p>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={!er || !signer}
                    loading={asked[key] === "busy"}
                    onClick={async () => {
                      if (!er || !signer) return;
                      setAsked((a) => ({ ...a, [key]: "busy" }));
                      try {
                        await requestJoin(base, er, signer, c.room);
                        setAsked((a) => ({ ...a, [key]: "done" }));
                      } catch (e) {
                        setAsked((a) => ({ ...a, [key]: e instanceof Error ? e.message : "Could not ask" }));
                      }
                    }}
                  >
                    Ask to join as a lender
                  </Button>
                )}
                {asked[key] && !["busy", "done"].includes(asked[key]) && <p className={styles.error}>{asked[key]}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
