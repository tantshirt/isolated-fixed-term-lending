"use client";

import { useEffect, useState } from "react";
import { signatureUrl } from "@/lib/transaction-lifecycle";
import { STAGE_LABEL, listReceipts, type ExecutionReceipt } from "@/lib/private/receipts";
import styles from "./private.module.css";

/** Recent private activity, with "done in the rollup" kept apart from "settled on Solana". */
export function ReceiptList({ wallet, refresh }: { wallet: string | null; refresh: number }) {
  const [items, setItems] = useState<ExecutionReceipt[]>([]);
  useEffect(() => {
    if (!wallet) return setItems([]);
    try {
      setItems(listReceipts(wallet).slice(0, 6));
    } catch {
      setItems([]);
    }
  }, [wallet, refresh]);

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
