"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useEffect, useState } from "react";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { DemoRoles } from "./DemoRoles";
import { Sheet } from "./Sheet";
import styles from "./ConnectDialog.module.css";

export function ConnectDialog() {
  const { connectOpen, setConnectOpen } = useSigner();
  const { wallets, select, connect, wallet, connecting, connected } = useWallet();
  const toast = useToast();
  const [pending, setPending] = useState<WalletName | null>(null);

  const installed = wallets.filter(
    (w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable,
  );

  // select() then connect() once the adapter is chosen.
  useEffect(() => {
    if (!pending || wallet?.adapter.name !== pending || connected || connecting) return;
    connect()
      .then(() => {
        setConnectOpen(false);
        toast({ tone: "success", title: `${pending} connected` });
      })
      .catch((e: unknown) =>
        toast({ tone: "error", title: "Wallet did not connect", detail: e instanceof Error ? e.message : undefined }),
      )
      .finally(() => setPending(null));
  }, [pending, wallet, connect, connected, connecting, setConnectOpen, toast]);

  return (
    <Sheet
      open={connectOpen}
      onClose={() => setConnectOpen(false)}
      title="Connect to Tenor"
      description="Sign with a browser wallet, or act as one of the funded demo wallets."
    >
      <section className={styles.section}>
        <h3 className={styles.heading}>Browser wallet</h3>
        {installed.length ? (
          <ul className={styles.wallets}>
            {installed.map((w) => (
              <li key={w.adapter.name}>
                <button
                  type="button"
                  className={styles.wallet}
                  disabled={Boolean(pending)}
                  onClick={() => {
                    setPending(w.adapter.name);
                    select(w.adapter.name);
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={w.adapter.icon} alt="" width={28} height={28} />
                  <span>{w.adapter.name}</span>
                  <span className={styles.state}>{pending === w.adapter.name ? "Approve in wallet…" : "Detected"}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.none}>
            No browser wallet found. Install Phantom or Solflare and point it at localhost, or use a demo wallet below.
          </p>
        )}
      </section>
      <section className={styles.section}>
        <h3 className={styles.heading}>Demo wallets</h3>
        <DemoRoles onPicked={() => setConnectOpen(false)} />
      </section>
    </Sheet>
  );
}
