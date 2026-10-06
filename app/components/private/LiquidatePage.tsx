"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pollAfterCompletion } from "@/lib/private/poll";
import { Button } from "@/components/ui/Button";
import { fundQuote, listQuotes, settleTicket, type Quote } from "@/lib/private/liquidation";
import { verifyQuoteAction } from "@/lib/private/quote-safety";
import { usePrivate } from "@/lib/private/use-private";
import { TeeCard } from "./TeeCard";
import styles from "./private.module.css";

const usdc = (a: bigint) => (Number(a) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
const wsol = (a: bigint) => (Number(a) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 });

export function LiquidatePage() {
  const { signer, base, er, status, error, connect } = usePrivate();
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [loadedIdentity, setLoadedIdentity] = useState("");
  const [checkedAt, setCheckedAt] = useState(0);
  const identity = `${signer?.publicKey.toBase58() ?? ""}:${er?.rpcEndpoint ?? ""}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const readSequence = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++readSequence.current;
    if (!er || status !== "ready") return;
    try {
      const fresh = await listQuotes(er);
      if (currentIdentity.current !== identity || sequence !== readSequence.current) return;
      setQuotes(fresh);
      setLoadedIdentity(identity);
      setReadError(null);
      setCheckedAt(Date.now());
    } catch (e) {
      if (currentIdentity.current !== identity || sequence !== readSequence.current) return;
      setQuotes(null);
      setCheckedAt(0);
      setReadError(e instanceof Error ? e.message : "The quote service is unavailable.");
    }
  }, [er, status, identity]);
  useEffect(() => {
    setQuotes(null);
    setCheckedAt(0);
    setReadError(null);
    setMsg(null);
    const sequenceRef = readSequence;
    const stop = pollAfterCompletion(load, 5000);
    const clock = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => { stop(); clearInterval(clock); sequenceRef.current++; };
  }, [load]);
  const verified = loadedIdentity === identity && status === "ready" && !readError && checkedAt > 0 && now * 1000 - checkedAt < 15000;

  async function currentQuote(q: Quote, funding: boolean) {
    if (!er || !signer || !verified || busy) throw new Error("Refresh quotes and verify your private session before continuing.");
    const fresh = (await listQuotes(er)).find((x) => x.address.equals(q.address));
    if (currentIdentity.current !== identity) throw new Error("Your wallet changed. Reopen your tickets before continuing.");
    return verifyQuoteAction(q, fresh, signer.publicKey, funding, Date.now() / 1000);
  }

  const me = signer?.publicKey;
  const open = (quotes ?? []).filter((q) => q.state === "open" && q.expiresAt > now);
  const mine = (quotes ?? []).filter((q) => me && q.tickets.some((t) => t.liquidator.equals(me) && (t.state === "funded" || t.state === "won")));

  async function act(key: string, f: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await f();
      if (currentIdentity.current !== identity) return;
      setMsg({ tone: "ok", text: ok });
      await load();
    } catch (e) {
      if (currentIdentity.current === identity) setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) });
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
        <p className={styles.hint}>Funding reserves private USDC; it does not guarantee execution. After execution, collect wSOL into your private balance. If the quote expires, changes revision or is withdrawn without executing your ticket, reclaim the reserved USDC here. Depositing and withdrawing from your private balance are separate wallet-approved steps.</p>
        <p className={styles.hint}>Quote amounts are public and say something about the loan&apos;s size. Execution rechecks the live price, the deadline, and your minimum payout.</p>
      </header>
      {status !== "ready" ? (
        <div className={styles.narrow}>
          <TeeCard status={status} error={error} onConnect={connect} />
        </div>
      ) : (
        <div className={styles.main}>
          {readError && <div role="alert" className={styles.error}><p>Quotes are unavailable. Current eligibility and your tickets could not be verified. No money action is available.</p><p>{readError}</p><Button variant="secondary" onClick={() => void load()}>Retry quotes</Button></div>}
          <section className={styles.panel} aria-labelledby="open-h">
            <header className={styles.panelHead}>
              <h2 id="open-h">Open quotes</h2>
              <span className={styles.badge}>{verified ? open.length : "Unverified"}</span>
            </header>
            <div className={styles.panelBody}>
              {readError ? <p className={styles.muted}>Waiting for a successful quote check.</p> : quotes === null ? (
                <p className={styles.muted} aria-busy>
                  Loading…
                </p>
              ) : open.length === 0 ? (
                <p className={styles.muted}>No open quotes were returned by the latest check. This does not establish the health of every private loan.</p>
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
                      onClick={() => signer && er && act(q.address.toBase58(), async () => fundQuote(base, er, signer, await currentQuote(q, true)), "Funded. The next automatic check settles it if the loan is still eligible.")}
                      loading={busy === q.address.toBase58()}
                      disabled={!verified || busy !== null || q.tickets.length >= 4}
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
              {readError || quotes === null ? <p className={styles.muted}>{readError ? "Your tickets are unavailable until the connection recovers." : "Checking your tickets…"}</p> : mine.length === 0 ? (
                <p className={styles.muted}>Tickets you fund show here until you collect them.</p>
              ) : (
                mine.map((q) => {
                  const t = q.tickets.find((x) => me && x.liquidator.equals(me) && (x.state === "funded" || x.state === "won"))!;
                  const won = t.state === "won";
                  const refundable = !won && (q.state !== "open" || t.revision !== q.revision || q.expiresAt < now);
                  return (
                    <article key={q.address.toBase58()} className={styles.loanCard}>
                      <p className={styles.loanStatus}>{won ? `Executed: ${wsol(t.payout)} wSOL to collect` : refundable ? "Did not execute: refund ready" : "Waiting for the next check"}</p>
                      <Button
                        variant={won ? "primary" : "secondary"}
                        disabled={!verified || busy !== null || (!won && !refundable)}
                        loading={busy === `s-${q.address.toBase58()}`}
                        onClick={() => signer && er && act(`s-${q.address.toBase58()}`, async () => settleTicket(base, er, signer, await currentQuote(q, false)), won ? "Collected." : "Refunded.")}
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
