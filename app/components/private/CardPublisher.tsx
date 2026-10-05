"use client";

import type { Connection, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { SHOW, publishCard, readJoinQueue } from "@/lib/private/discovery";
import { inviteMember } from "@/lib/private/rooms";
import styles from "./private.module.css";

const short = (k: PublicKey) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`;

/** Owner only: an opt-in public card, and the private queue of lenders who asked to join. */
export function CardPublisher({ signer, base, er, room, members, onChange }: { signer: LoanSigner; base: Connection; er: Connection; room: PublicKey; members: PublicKey[]; onChange: () => void }) {
  const [show, setShow] = useState<number>(SHOW.amount | SHOW.duration);
  const [amount, setAmount] = useState("0.10");
  const [rate, setRate] = useState("6");
  const [days, setDays] = useState("7");
  const [note, setNote] = useState("wSOL at about 50% LTV");
  const [queue, setQueue] = useState<{ wallet: PublicKey; at: number }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => setQueue(await readJoinQueue(er, room)), [er, room]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 6000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = (bit: number) => setShow((s) => s ^ bit);
  const units = (v: string, d: number) => BigInt(Math.round(Number(v || "0") * 10 ** d));

  async function publish() {
    setBusy("publish");
    setMsg(null);
    try {
      await publishCard(base, er, signer, room, {
        show,
        amountMin: units(amount, 6),
        amountMax: units(amount, 6),
        maxInterestBps: Math.round(Number(rate || "0") * 100),
        durationSeconds: Math.round(Number(days || "0") * 86_400),
        collateralNote: note,
      });
      setMsg({ tone: "ok", text: "Published. It appears on the Discover page with only the fields you ticked." });
      await load();
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  const pending = (queue ?? []).filter((q) => !members.some((m) => m.equals(q.wallet)));

  return (
    <section className={styles.panel} aria-labelledby="card-h">
      <header className={styles.panelHead}>
        <h2 id="card-h">Find lenders</h2>
        <span className={styles.badge}>Opt-in public</span>
      </header>
      <div className={styles.panelBody}>
        <p className={styles.hint}>Publish a card on Discover. Only the boxes you tick are stored; the rest is never written.</p>
        <fieldset className={styles.fields}>
          <legend className="visually-hidden">Fields to show</legend>
          <label>
            <input type="checkbox" checked={!!(show & SHOW.amount)} onChange={() => toggle(SHOW.amount)} /> Amount
            <input className={styles.inputSm} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount in USDC" /> USDC
          </label>
          <label>
            <input type="checkbox" checked={!!(show & SHOW.rate)} onChange={() => toggle(SHOW.rate)} /> Up to
            <input className={styles.inputSm} value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" aria-label="Maximum interest percent" /> % interest
          </label>
          <label>
            <input type="checkbox" checked={!!(show & SHOW.duration)} onChange={() => toggle(SHOW.duration)} /> For
            <input className={styles.inputSm} value={days} onChange={(e) => setDays(e.target.value)} inputMode="decimal" aria-label="Term in days" /> days
          </label>
          <label>
            <input type="checkbox" checked={!!(show & SHOW.collateral)} onChange={() => toggle(SHOW.collateral)} /> Collateral
            <input className={styles.input} value={note} maxLength={48} onChange={(e) => setNote(e.target.value)} aria-label="Collateral note" />
          </label>
        </fieldset>
        <Button variant="secondary" onClick={publish} loading={busy === "publish"} disabled={!show}>
          Publish card
        </Button>
        <div>
          <p className={styles.fieldLabel}>Asked to join {queue === null ? "" : `(${pending.length})`}</p>
          {queue === null ? (
            <p className={styles.hint}>Publish a card to open a private queue only you can read.</p>
          ) : pending.length === 0 ? (
            <p className={styles.hint}>No one is waiting.</p>
          ) : (
            <ul className={styles.members}>
              {pending.map((q) => (
                <li key={q.wallet.toBase58()}>
                  <span className={styles.mono}>{short(q.wallet)}</span>
                  <span className={styles.hint}>{new Date(q.at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                  <button
                    className={styles.textAccent}
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(q.wallet.toBase58());
                      try {
                        await inviteMember(base, er, signer, room, q.wallet, "lender");
                        onChange();
                        await load();
                      } catch (e) {
                        setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) });
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    Invite as lender
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {msg && (
          <p role={msg.tone === "error" ? "alert" : "status"} className={msg.tone === "error" ? styles.error : styles.ok}>
            {msg.text}
          </p>
        )}
      </div>
    </section>
  );
}
