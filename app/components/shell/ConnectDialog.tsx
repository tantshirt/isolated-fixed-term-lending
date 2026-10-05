"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useEffect, useRef, useState } from "react";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { useDevConfig } from "@/lib/client/hooks";
import { NETWORK } from "@/lib/constants";
import { hasInjectedMetaMask, registerMetaMask } from "@/lib/client/metamask";
import {
  WALLET_CATALOG,
  walletBrand,
  walletUnavailableReason,
} from "@/lib/wallet-catalog";
import { AssetIcon } from "@/components/brand/AssetLabel";
import { DemoRoles } from "./DemoRoles";
import { Sheet } from "./Sheet";
import styles from "./ConnectDialog.module.css";

export function ConnectDialog() {
  const { localControls } = useDevConfig();
  const { connectOpen, setConnectOpen } = useSigner();
  const { wallets, select, connect, wallet, connecting, connected } =
    useWallet();
  const toast = useToast();
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState<WalletName | null>(null);
  const [error, setError] = useState("");
  const [metaState, setMetaState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [retryMeta, setRetryMeta] = useState(0);
  const attempted = useRef<WalletName | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    setMounted(true);
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (NETWORK !== "devnet") return;
    let mounted = true,
      started = false;
    const prepare = () => {
      if (started || /Android|iPhone|iPad/i.test(navigator.userAgent)) return;
      started = true;
      setMetaState("loading");
      registerMetaMask()
        .then(() => {
          if (mounted) setMetaState("ready");
        })
        .catch(() => {
          if (mounted) setMetaState("error");
        });
    };
    const announce = (event: Event) => {
      const info = (event as CustomEvent<{ info?: { rdns?: string } }>).detail
        ?.info;
      if (info?.rdns === "io.metamask") prepare();
    };
    window.addEventListener("eip6963:announceProvider", announce);
    if (hasInjectedMetaMask()) prepare();
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => {
      mounted = false;
      window.removeEventListener("eip6963:announceProvider", announce);
    };
  }, [retryMeta]);

  // A click selects an adapter; this effect connects it exactly once, including after rejection.
  useEffect(() => {
    if (
      !pending ||
      wallet?.adapter.name !== pending ||
      connecting ||
      attempted.current === pending
    )
      return;
    if (connected) {
      setPending(null);
      setConnectOpen(false);
      return;
    }
    attempted.current = pending;
    void connect()
      .then(() => {
        if (!alive.current) return;
        setConnectOpen(false);
        toast({ tone: "success", title: `${pending} connected` });
      })
      .catch(() => {
        if (alive.current)
          setError(
            "The connection was not approved. Unlock your wallet and choose it again when you’re ready."
          );
      })
      .finally(() => {
        if (alive.current) setPending(null);
      });
  }, [pending, wallet, connect, connected, connecting, setConnectOpen, toast]);

  const detected = wallets.filter(
    (w) =>
      mounted && (w.readyState === WalletReadyState.Installed ||
      w.readyState === WalletReadyState.Loadable)
  );
  const entries = [
    ...WALLET_CATALOG.map((brand) => ({
      ...brand,
      detected: detected.find(
        (w) => walletBrand(w.adapter.name)?.id === brand.id
      ),
    })),
    ...detected
      .filter((w) => !walletBrand(w.adapter.name))
      .map((w) => ({
        id: w.adapter.name,
        name: w.adapter.name,
        icon: w.adapter.icon,
        url: w.adapter.url,
        detected: w,
      })),
  ].sort((a, b) => Number(Boolean(b.detected)) - Number(Boolean(a.detected)));

  return (
    <Sheet
      open={connectOpen}
      onClose={() => setConnectOpen(false)}
      title="Choose your wallet"
      description={`Connect to explore loans with ${
        NETWORK === "devnet" ? "Devnet" : "local"
      } test tokens.`}
    >
      <div className={styles.network}>
        <AssetIcon symbol="SOL" />
        <div>
          <strong>Solana {NETWORK === "devnet" ? "Devnet" : "Localnet"}</strong>
          <span>You approve every transaction in your wallet.</span>
        </div>
      </div>
      <section className={styles.section} aria-label="Wallet choices">
        <div className={styles.sectionHead}>
          <h3 className={styles.heading}>Your wallet, your choice</h3>
          <span>
            {detected.length
              ? `${detected.length} available`
              : "Browser extension"}
          </span>
        </div>
        <ul className={styles.wallets}>
          {entries.map((entry) => {
            const unavailable = entry.detected
              ? walletUnavailableReason(entry.detected.adapter, NETWORK)
              : null;
            const loading =
              entry.id === "metamask" &&
              metaState === "loading" &&
              !entry.detected;
            const contents = (
              <>
                <span className={styles.walletIcon}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={entry.icon} alt="" width={40} height={40} />
                </span>
                <span className={styles.walletName}>
                  {entry.name}
                  <small>
                    {unavailable ||
                      (entry.detected
                        ? "Ready to connect"
                        : loading
                        ? "Preparing Solana connection…"
                        : entry.id === "metamask"
                        ? "Devnet on desktop extension"
                        : "Solana wallet")}
                  </small>
                </span>
                <span className={styles.state}>
                  {pending === entry.detected?.adapter.name
                    ? "Approve…"
                    : unavailable
                    ? "Unavailable"
                    : entry.detected
                    ? "Connect →"
                    : loading
                    ? "Loading…"
                    : "Get wallet ↗"}
                </span>
              </>
            );
            return (
              <li key={entry.id}>
                {entry.detected || loading ? (
                  <button
                    type="button"
                    className={styles.wallet}
                    disabled={
                      Boolean(pending) || Boolean(unavailable) || loading
                    }
                    onClick={() => {
                      if (!entry.detected) return;
                      setError("");
                      attempted.current = null;
                      setPending(entry.detected.adapter.name);
                      select(entry.detected.adapter.name);
                    }}
                  >
                    {contents}
                  </button>
                ) : (
                  <a
                    className={styles.wallet}
                    href={entry.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Get ${entry.name} wallet (opens a new tab)`}
                  >
                    {contents}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {metaState === "error" && (
          <p className={styles.error}>
            MetaMask’s Solana connection could not load.{" "}
            <button type="button" onClick={() => setRetryMeta((n) => n + 1)}>
              Retry MetaMask
            </button>
          </p>
        )}
        <p className={styles.hint}>
          Already installed? Unlock your extension and enable it for this site.
          Only wallets that support this network can connect.
        </p>
      </section>
      {localControls && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Local wallets</h3>
          <DemoRoles onPicked={() => setConnectOpen(false)} />
        </section>
      )}
      <div className={styles.demo}>
        <span>Just looking around?</span>
        <Link href="/demo" onClick={() => setConnectOpen(false)}>
          Try the wallet-free demo →
        </Link>
      </div>
    </Sheet>
  );
}
