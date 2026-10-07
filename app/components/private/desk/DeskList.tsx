"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Connection } from "@solana/web3.js";
import { Button } from "@/components/ui/Button";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { shortKey } from "@/lib/format";
import { PRIVATE_V2_LIVE } from "@/lib/private/v2-codec";
import { deskPath, deskRef, openDesk, savedDesks } from "@/lib/private/v2-desks";
import styles from "../private.module.css";
import s from "./Desk.module.css";

/** The desks this wallet opened or joined, from ids kept in this browser. Contents stay in the TEE. */
export function DeskList({ signer, base, er, ready }: { signer: LoanSigner | null; base: Connection | null; er: Connection | null; ready: boolean }) {
  const router = useRouter();
  const wallet = signer?.publicKey.toBase58() ?? null;
  const [desks, setDesks] = useState<{ creator: string; deskId: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setDesks(wallet ? savedDesks(wallet) : []), [wallet]);

  if (!PRIVATE_V2_LIVE) return <p className={styles.hint}>Private desks open once the desk program is on Devnet.</p>;
  return (
    <div className={s.deskIndex}>
      {desks.length === 0 ? (
        <p className={styles.hint}>{ready ? "No desks yet." : "Sign in privately to open or join a desk."}</p>
      ) : (
        <ul className={s.deskLinks}>
          {desks.map((d) => {
            const anchor = deskRef(d.creator, d.deskId).anchor.toBase58();
            return (
              <li key={d.deskId}>
                <Link href={deskPath(d)}>
                  Desk <span className="mono">{shortKey(anchor)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {ready && signer && base && er && <p className={styles.hint}>Your wallet signs to create it. You become its administrator and a lender.</p>}
      {ready && signer && base && er && (
        <Button
          variant="secondary"
          block
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const d = await openDesk(base, er, signer, true);
              router.push(deskPath(d));
            } catch (e) {
              setErr(e instanceof Error ? e.message : "The desk could not be created.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Create a desk
        </Button>
      )}
      {err && (
        <p role="alert" className={styles.error}>
          {err}
        </p>
      )}
    </div>
  );
}
