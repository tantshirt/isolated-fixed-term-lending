"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { type Cursor, nextCursor, rowsAfter, toCsv } from "@/lib/export/activity";
import { privateActivityRows } from "@/lib/export/private-activity";
import { publicActivityRows } from "@/lib/export/public-activity";
import { usePrivate } from "@/lib/private/use-private";
import { useV2Positions } from "@/lib/private/use-v2-positions";
import { getConnection } from "@/lib/program";
import { shortKey } from "@/lib/format";
import s from "./MyLoans.module.css";

/** Activity export (Story 26.8). Client-only: public rows from chain, private rows from this browser's rollup reads. */
export const EXPORT_ENABLED = process.env.NEXT_PUBLIC_EXPORT_ENABLED === "1";

const cursorKey = (wallet: string) => `zenlo:export-cursor:${wallet}`;

function readCursor(wallet: string): Cursor | null {
  try {
    const raw = localStorage.getItem(cursorKey(wallet));
    const c = raw ? (JSON.parse(raw) as Cursor) : null;
    return c && typeof c.slot === "number" && typeof c.signature === "string" ? c : null;
  } catch {
    return null;
  }
}

function saveCursor(wallet: string, c: Cursor | null) {
  try {
    if (c) localStorage.setItem(cursorKey(wallet), JSON.stringify(c));
  } catch {
    // A blocked store only loses the "new since" convenience.
  }
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * "Export activity" in My loans. Public rows are rebuilt from chain behind a `(slot, signature)`
 * cursor, so the same history always gives the same file. Private rows are assembled here from the
 * loans this browser already read through the rollup; they never go to a server.
 */
export function ExportActivity({ wallet }: { wallet: string }) {
  const { signer, er, status } = usePrivate();
  const privateWallet = signer?.publicKey ?? null;
  const positions = useV2Positions(status === "ready" ? er : null, privateWallet);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [since, setSince] = useState<Cursor | null>(null);
  useEffect(() => setSince(readCursor(wallet)), [wallet]);

  if (!EXPORT_ENABLED) return null;

  const run = async (onlyNew: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      const pub = await publicActivityRows(getConnection(), wallet);
      const priv = privateWallet?.toBase58() === wallet && positions ? privateActivityRows(positions) : [];
      // Private rows are ledger facts to date, not slot-ordered events, so they are always included.
      const rows = [...rowsAfter(pub, onlyNew ? since : null), ...priv];
      const date = new Date().toISOString().slice(0, 10);
      download(`zenlo-activity-${shortKey(wallet).replace(/[^A-Za-z0-9]/g, "")}-${date}.csv`, toCsv(rows));
      const next = nextCursor(pub) ?? since;
      saveCursor(wallet, next);
      setSince(next);
      setNote(
        `${rows.length} row${rows.length === 1 ? "" : "s"} exported.${positions ? "" : " Private loans were not included: open your private rooms first so this browser can read them."} This is an activity record, not tax advice.`,
      );
    } catch {
      setNote("The complete transaction history could not be read. Nothing was exported. Try again with an archival Devnet RPC that provides historical transactions and block order.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.headActions}>
      <Button variant="secondary" loading={busy} onClick={() => run(false)}>
        Export activity
      </Button>
      {since && (
        <Button variant="ghost" loading={busy} onClick={() => run(true)}>
          Only new since last export
        </Button>
      )}
      {note && (
        <p role="status" className={s.exportNote}>
          {note}
        </p>
      )}
    </div>
  );
}
