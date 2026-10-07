"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { formatDeadline } from "@/lib/format";
import {
  decodeCreditHistory,
  decodeHistoryAttestation,
  EXPORT_NOTE,
  historyAttestationPda,
  historyCsv,
  historyJson,
  historyPda,
  repaidOf,
  type CreditHistory,
  type HistoryAttestation,
} from "@/lib/private/history";
import { usePrivate } from "@/lib/private/use-private";
import styles from "./Credit.module.css";

type Read = { state: "reading" } | { state: "absent" } | { state: "unavailable" } | { state: "ready"; history: CreditHistory; readAt: number };

/** Saves text as a file from the browser. Nothing is uploaded. */
function save(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Story 26.7: the borrower's own private repayment history, read from the rollup with their TEE
 * session and exported in the browser. Locked or unreadable history is never shown as zero.
 */
export function HistoryPanel() {
  const { signer, base, er, status, error, connect } = usePrivate();
  const [read, setRead] = useState<Read>({ state: "reading" });
  const [attestation, setAttestation] = useState<HistoryAttestation | null | undefined>(undefined);
  const [refresh, setRefresh] = useState(0);
  const wallet = signer?.publicKey ?? null;
  const key = wallet?.toBase58() ?? null;

  useEffect(() => {
    if (!er || !wallet) return;
    let live = true;
    setRead({ state: "reading" });
    er.getAccountInfo(historyPda(wallet), "confirmed")
      .then((info) => {
        if (!live) return;
        if (!info) return setRead({ state: "absent" });
        const history = decodeCreditHistory(info.data);
        setRead(history && history.borrower === key ? { state: "ready", history, readAt: Math.floor(Date.now() / 1000) } : { state: "unavailable" });
      })
      .catch(() => live && setRead({ state: "unavailable" }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [er, key, refresh]);

  useEffect(() => {
    if (!wallet) return;
    let live = true;
    setAttestation(undefined);
    base
      .getAccountInfo(historyAttestationPda(wallet), "confirmed")
      .then((info) => {
        if (!live) return;
        const a = info ? decodeHistoryAttestation(info.data) : null;
        setAttestation(a && a.borrower === key && a.attestedAt > 0 ? a : null);
      })
      .catch(() => live && setAttestation(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, key, refresh]);

  return (
    <section className={styles.panel} aria-labelledby="history-h">
      <h2 id="history-h">Repayment history</h2>
      <p className={styles.note}>Your private loans, counted once each when they settle. Only you can read this, through your own private session.</p>
      {!wallet ? (
        <p className={styles.note}>Connect a wallet to read your history.</p>
      ) : !er ? (
        <>
          <p className={styles.note}>Locked. Sign in to the private rollup to read it; nothing is shown until then.</p>
          {error && <p className={styles.warn} role="alert">{error}</p>}
          <div className={styles.row}>
            <Button onClick={() => void connect()} loading={status === "verifying" || status === "signing"} disabled={status === "no-sign-message"}>
              Unlock private history
            </Button>
          </div>
          {status === "no-sign-message" && <p className={styles.warn}>This wallet cannot sign messages, so it cannot open a private session.</p>}
        </>
      ) : read.state === "reading" ? (
        <p className={styles.note} role="status">Reading your history from the private rollup…</p>
      ) : read.state === "unavailable" ? (
        <>
          <p className={styles.warn} role="alert">Your history could not be read right now. Its state is unknown.</p>
          <div className={styles.row}>
            <Button variant="ghost" onClick={() => setRefresh((n) => n + 1)}>
              Try again
            </Button>
          </div>
        </>
      ) : read.state === "absent" ? (
        <p className={styles.note}>No history yet. A private loan is added once it settles and its history is recorded.</p>
      ) : (
        <>
          <dl className={styles.facts}>
            <Fact label="Repaid" value={repaidOf(read.history)} />
            <Fact label="On time" value={read.history.onTime} />
            <Fact label="Late (in grace)" value={read.history.late} />
            <Fact label="Liquidated" value={read.history.liquidated} />
            <Fact label="Defaulted (recovery)" value={read.history.defaulted} />
            <Fact label="Refinanced" value={read.history.refinanced} />
            {read.history.lastSettledAt > 0 && (
              <div>
                <dt>Last settlement</dt>
                <dd className="num">{formatDeadline(read.history.lastSettledAt)}</dd>
              </div>
            )}
          </dl>
          <div className={styles.row}>
            <Button variant="secondary" onClick={() => save(`zenlo-history-${key!.slice(0, 8)}.json`, "application/json", historyJson(read.history, read.readAt))}>
              Export JSON
            </Button>
            <Button variant="secondary" onClick={() => save(`zenlo-history-${key!.slice(0, 8)}.csv`, "text/csv", historyCsv(read.history, read.readAt))}>
              Export CSV
            </Button>
          </div>
          <p className={styles.note}>{EXPORT_NOTE} The file is made on this device and is not uploaded anywhere.</p>
        </>
      )}
      {wallet && attestation && (
        <div className={styles.facts}>
          <p className={styles.note}>
            <strong>Published attestation</strong>: {attestation.repaid} repaid ({attestation.onTime} on time, {attestation.late} late), {attestation.liquidated} liquidated,{" "}
            {attestation.defaulted} defaulted, across {attestation.loansCounted} loans. Read at rollup slot <span className="num">{attestation.rollupSlot.toString()}</span>,{" "}
            {formatDeadline(attestation.attestedAt)}.
          </p>
          <p className={styles.warn}>Publishing made these counts public on Solana. Your loans and terms stay private.</p>
        </div>
      )}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}
