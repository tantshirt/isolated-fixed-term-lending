"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { AssetLabel } from "@/components/brand/AssetLabel";
import { walletBrand } from "@/lib/wallet-catalog";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useBalances, useDevConfig } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { formatUsdc, formatWsol, shortKey } from "@/lib/format";
import { Avatar } from "./Avatar";
import styles from "./AccountButton.module.css";

const ROLE_NAMES = {
  lender: "Demo lender",
  borrower: "Demo borrower",
  liquidator: "Demo liquidator",
} as const;

export function AccountButton() {
  const { wallet } = useWallet();
  const {
    publicKey,
    source,
    localRole,
    walletName,
    setConnectOpen,
    disconnect,
    bumpRefresh,
  } = useSigner();
  const { config, localControls } = useDevConfig();
  const balances = useBalances(publicKey, config);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [funding, setFunding] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!publicKey) {
    return (
      <Button onClick={() => setConnectOpen(true)} className={styles.connect}>
        Connect
      </Button>
    );
  }

  const key = publicKey.toBase58();
  const icon =
    source === "wallet"
      ? walletBrand(walletName ?? "")?.icon ?? wallet?.adapter.icon
      : undefined;
  const name = localRole ? ROLE_NAMES[localRole] : walletName ?? "Wallet";

  const fund = async () => {
    setFunding(true);
    try {
      const r = await fetch("/api/fund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey: key }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Funding failed");
      toast({
        tone: "success",
        title: "Wallet funded",
        detail: "2 SOL, 10,000 USDC and 50 wSOL arrived.",
      });
      bumpRefresh();
    } catch (e) {
      toast({
        tone: "error",
        title: "Could not fund this wallet",
        detail: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setFunding(false);
    }
  };

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={styles.account}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        {icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={icon}
            alt=""
            width={32}
            height={32}
            className={styles.walletIcon}
          />
        ) : (
          <Avatar seed={key} role={localRole} />
        )}
        <span className={styles.who}>
          <span className={styles.name}>{name}</span>
          <span className={`${styles.key} address`}>{shortKey(key)}</span>
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <m.div
            role="dialog"
            aria-label="Account"
            className={styles.menu}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className={styles.menuHead}>
              {icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={icon}
                  alt=""
                  width={40}
                  height={40}
                  className={styles.walletIcon}
                />
              ) : (
                <Avatar seed={key} role={localRole} size={40} />
              )}
              <div>
                <p className={styles.name}>{name}</p>
                <button
                  type="button"
                  className={`${styles.copy} address`}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(key);
                      toast({ tone: "info", title: "Address copied" });
                    } catch {
                      toast({
                        tone: "error",
                        title: "Could not copy address",
                        detail: "Copy the address from your wallet.",
                      });
                    }
                  }}
                >
                  {shortKey(key)} · Copy
                </button>
              </div>
            </div>
            <dl className={styles.balances}>
              <div>
                <dt>
                  <AssetLabel symbol="USDC" />
                </dt>
                <dd className="num">
                  {balances ? formatUsdc(balances.usdc) : "—"}
                </dd>
              </div>
              <div>
                <dt>
                  <AssetLabel symbol="wSOL" />
                </dt>
                <dd className="num">
                  {balances ? formatWsol(balances.wsol) : "—"}
                </dd>
              </div>
              <div>
                <dt>
                  <AssetLabel symbol="SOL">SOL for fees</AssetLabel>
                </dt>
                <dd className="num">
                  {balances ? balances.sol.toFixed(3) : "—"}
                </dd>
              </div>
            </dl>
            <div className={styles.actions}>
              {localControls && source === "wallet" && (
                <Button
                  variant="secondary"
                  block
                  loading={funding}
                  onClick={fund}
                >
                  Fund with test tokens
                </Button>
              )}
              <Button
                variant="secondary"
                block
                onClick={() => {
                  setOpen(false);
                  setConnectOpen(true);
                }}
              >
                Switch wallet
              </Button>
              <Button
                variant="ghost"
                block
                onClick={() => {
                  setOpen(false);
                  void disconnect();
                }}
              >
                Disconnect
              </Button>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
