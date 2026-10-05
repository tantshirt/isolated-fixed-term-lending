"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { fundQuote, listQuotes, settleTicket, type Quote } from "@/lib/private/liquidation";
import { usePrivate } from "@/lib/private/use-private";
import { TeeCard } from "./TeeCard";
import styles from "./private.module.css";

const usdc = (a: bigint) => (Number(a) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
const wsol = (a: bigint) => (Number(a) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 });

export function LiquidatePage() {
  const { signer, base, er, status, error, connect } = usePrivate();
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const load = useCallback(async () => {
    if (!er) return;
    try {
      setQuotes(await listQuotes(er));
    } catch {
      setQuotes([]);
    }
  }, [er]);
  useEffect(() => {
    void load();
    const t = setInterval(() => (setNow(Date.now() / 1000), void load()), 5000);
    return () => clearInterval(t);
  }, [load]);

  const me = signer?.publicKey;
  const open = (quotes ?? []).filter((q) => q.state === "open" && q.expiresAt > now);
  const mine = (quotes ?? []).filter((q) => me && q.tickets.some((t) => t.liquidator.equals(me) && (t.state === "funded" || t.state === "won")));

  async function act(key: string, f: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await f();
      setMsg({ tone: "ok", text: ok });
      await load();
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <header className={styles.hero}>
        <h1 className={styles.title}>Liquidation quotes</h1>
        <p className={styles.lede}>
          When a private loan crosses its liquidation line, its automatic check posts a short-lived quote: the debt to pay and the wSOL you
          receive. You never see the loan itself. Fund a quote from your private USDC; if it executes you collect the wSOL, otherwise you get
          your USDC back.
        </p>
        <p className={styles.hint}>Quote amounts are public and say something about the loan&apos;s size. Execution rechecks the live price, the deadline, and your minimum payout.</p>
      </header>
      {status !== "ready" ? (
        <div className={styles.narrow}>
          <TeeCard status={status} error={error} onConnect={connect} />
        </div>
      ) : (
        <div className={styles.main}>
          <section className={styles.panel} aria-labelledby="open-h">
            <header className={styles.panelHead}>
              <h2 id="open-h">Open quotes</h2>
              <span className={styles.badge}>{open.length}</span>
            </header>
            <div className={styles.panelBody}>
              {quotes === null ? (
                <p className={styles.muted} aria-busy>
                  Loading…
                </p>
              ) : open.length === 0 ? (
                <p className={styles.muted}>No loan is past its line right now. Healthy loans never show up here.</p>
              ) : (
                open.map((q) => (
                  <article key={q.address.toBase58()} className={styles.loanCard}>
                    <dl className={styles.summary}>
                      <div>
                        <dt>You pay</dt>
                        <dd className="num">{usdc(q.debt)} USDC</dd>
                      </div>
                      <div>
                        <dt>You receive at least</dt>
                        <dd className="num">{wsol(q.payout)} wSOL</dd>
                      </div>
                      <div>
                        <dt>Quote expires in</dt>
                        <dd className="num">{Math.max(0, Math.round(q.expiresAt - now))} s</dd>
                      </div>
                    </dl>
                    <Button
                      onClick={() => signer && er && act(q.address.toBase58(), () => fundQuote(base, er, signer, q), "Funded. The next automatic check settles it if the loan is still eligible.")}
                      loading={busy === q.address.toBase58()}
                      disabled={q.tickets.length >= 4}
                    >
                      Fund this quote
                    </Button>
                  </article>
                ))
              )}
            </div>
          </section>
          <section className={styles.panel} aria-labelledby="mine-h">
            <header className={styles.panelHead}>
              <h2 id="mine-h">Your tickets</h2>
            </header>
            <div className={styles.panelBody}>
              {mine.length === 0 ? (
                <p className={styles.muted}>Tickets you fund show here until you collect them.</p>
              ) : (
                mine.map((q) => {
                  const t = q.tickets.find((x) => me && x.liquidator.equals(me))!;
                  const won = t.state === "won";
                  const refundable = !won && (q.state !== "open" || t.revision !== q.revision || q.expiresAt < now);
                  return (
                    <article key={q.address.toBase58()} className={styles.loanCard}>
                      <p className={styles.loanStatus}>{won ? `Executed: ${wsol(t.payout)} wSOL to collect` : refundable ? "Did not execute: refund ready" : "Waiting for the next check"}</p>
                      <Button
                        variant={won ? "primary" : "secondary"}
                        disabled={!won && !refundable}
                        loading={busy === `s-${q.address.toBase58()}`}
                        onClick={() => signer && er && act(`s-${q.address.toBase58()}`, () => settleTicket(base, er, signer, q), won ? "Collected." : "Refunded.")}
                      >
                        {won ? "Collect wSOL" : "Get my USDC back"}
                      </Button>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        </div>
      )}
      {msg && (
        <p role={msg.tone === "error" ? "alert" : "status"} className={msg.tone === "error" ? styles.error : styles.toast}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
