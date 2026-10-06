"use client";

import { useEffect, useState } from "react";
import { signatureUrl } from "@/lib/transaction-lifecycle";
import type { Connection } from "@solana/web3.js";
import { RECEIPTS_CHANGED, STAGE_LABEL, listReceipts, reconcile, saveReceipt, type ExecutionReceipt } from "@/lib/private/receipts";
import styles from "./private.module.css";

/** Recent private activity, with "done in the rollup" kept apart from "settled on Solana". */
export function ReceiptList({ wallet, refresh, base, er }: { wallet: string | null; refresh: number; base: Connection; er: Connection | null }) {
  const [snapshot, setSnapshot] = useState<{ wallet: string; items: ExecutionReceipt[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!wallet) { setSnapshot(null); return; }
    let active = true;
    let busy = false;
    const read = () => {
      if (!active) return;
      try { setSnapshot({ wallet, items: listReceipts(wallet).slice(0, 6) }); setError(null); }
      catch { setError("Saved receipts could not be read. Keep this browser's storage and try again."); }
    };
    const check = async () => {
      read();
      if (busy) return;
      busy = true;
      try {
        for (const receipt of listReceipts(wallet)) {
          if (!active) return;
          if (receipt.stage !== "submitted" && receipt.stage !== "settling") continue;
          if (receipt.environment === "er" && !er) continue;
          const next = await reconcile(receipt, er ?? base, base);
          if (!active) return;
          if (next.stage !== receipt.stage) saveReceipt(wallet, next);
        }
        read();
      } catch { if (active) setError("Confirmation could not be checked. Saved signatures are kept; checking again shortly."); }
      finally { busy = false; }
    };
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === wallet) read(); };
    const storage = () => { void check(); };
    void check();
    const timer = setInterval(() => void check(), 5000);
    window.addEventListener(RECEIPTS_CHANGED, changed);
    window.addEventListener("storage", storage);
    return () => { active = false; clearInterval(timer); window.removeEventListener(RECEIPTS_CHANGED, changed); window.removeEventListener("storage", storage); };
  }, [wallet, refresh, base, er]);
  const items = snapshot?.wallet === wallet ? snapshot.items : [];
  if (error) return <p className={styles.hint} role="status">{error}</p>;

  if (!items.length) return <p className={styles.empty}>Your private actions will show here, with where each one stands.</p>;
  return (
    <ul className={styles.receipts}>
      {items.map((r) => (
        <li key={r.id} className={styles.receipt} data-stage={r.stage}>
          <span className={styles.receiptDot} aria-hidden />
          <span className={styles.receiptIntent}>{r.intent}</span>
          <span className={styles.receiptStage}>{STAGE_LABEL[r.stage]}</span>
          {r.baseSignature ? (
            <a className={styles.receiptLink} href={signatureUrl(r.baseSignature)} target="_blank" rel="noreferrer">
              Explorer
            </a>
          ) : (
            r.erSignature && (
              <span className={styles.receiptLink} title="Rollup transactions are visible only to members through the TEE">
                Private
              </span>
            )
          )}
        </li>
      ))}
    </ul>
  );
}
