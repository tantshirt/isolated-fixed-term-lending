"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSigner } from "@/lib/client/signer-context";
import { getConnection } from "@/lib/program";
import { attestTee, currentTeeSession, openTeeSession, type TeeSession } from "./tee";

export type TeeStatus = "no-wallet" | "no-sign-message" | "idle" | "verifying" | "signing" | "ready" | "error";

/** One private session per wallet: attest the TEE, then sign in with the wallet. */
export function usePrivate() {
  const { signer, source, setConnectOpen } = useSigner();
  const wallet = useWallet();
  const base = useMemo(() => getConnection(), []);
  const [tee, setTee] = useState<TeeSession | null>(null);
  const [status, setStatus] = useState<TeeStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const key = signer?.publicKey.toBase58();
  useEffect(() => {
    setError(null);
    if (!signer) return setTee(null), setStatus("no-wallet");
    const live = currentTeeSession(signer.publicKey);
    setTee(live);
    setStatus(live ? "ready" : source === "wallet" && !wallet.signMessage ? "no-sign-message" : "idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source, wallet.signMessage]);

  const connect = useCallback(async () => {
    if (!signer) return setConnectOpen(true);
    if (!wallet.signMessage) return setStatus("no-sign-message");
    setError(null);
    try {
      setStatus("verifying");
      await attestTee();
      setStatus("signing");
      const s = await openTeeSession(signer.publicKey, wallet.signMessage);
      setTee(s);
      setStatus("ready");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [signer, wallet.signMessage, setConnectOpen]);

  return { signer, base, tee, er: tee?.connection ?? null, status, error, connect };
}
