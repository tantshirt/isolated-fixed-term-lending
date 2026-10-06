"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSigner } from "@/lib/client/signer-context";
import { getConnection } from "@/lib/program";
import { attestTee, closeTeeSession, currentTeeSession, openTeeSession, resumeTeeSession, sessionMatchesWallet, type TeeSession } from "./tee";

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
  const activeKey = useRef(key);
  activeKey.current = key;
  const generation = useRef(0);
  useEffect(() => {
    const generationRef = generation;
    const version = ++generationRef.current;
    setError(null);
    setTee(null);
    if (!signer) setStatus("no-wallet");
    else {
      const live = currentTeeSession(signer.publicKey);
      setTee(live);
      setStatus(live ? "ready" : source === "wallet" && !wallet.signMessage ? "no-sign-message" : "idle");
      if (!live) void resumeTeeSession(signer.publicKey).then((session) => {
        if (generation.current !== version || activeKey.current !== key) return;
        if (session) { setTee(session); setStatus("ready"); }
      }).catch(() => {
        if (generation.current !== version || activeKey.current !== key) return;
        setStatus("error");
        setError("The private connection could not be verified. Try signing in again.");
      });
    }
    return () => { generationRef.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source, wallet.signMessage]);

  useEffect(() => {
    if (!tee || tee.wallet !== key) return;
    const expire = () => {
      if (sessionMatchesWallet(tee, activeKey.current)) return;
      if (signer && activeKey.current === tee.wallet) closeTeeSession(signer.publicKey);
      setTee(null);
      setStatus("error");
      setError("Your private session expired. Sign in again to continue.");
    };
    const timer = setTimeout(expire, Math.max(0, tee.expiresAt - Date.now() - 60_000 + 10));
    window.addEventListener("focus", expire);
    return () => { clearTimeout(timer); window.removeEventListener("focus", expire); };
  }, [tee, key, signer]);

  const connect = useCallback(async () => {
    if (!signer) return setConnectOpen(true);
    if (!wallet.signMessage) return setStatus("no-sign-message");
    const version = ++generation.current;
    const connectingKey = signer.publicKey.toBase58();
    const stillCurrent = () => generation.current === version && activeKey.current === connectingKey;
    setError(null);
    closeTeeSession(signer.publicKey);
    setTee(null);
    try {
      setStatus("verifying");
      await attestTee();
      if (!stillCurrent()) return;
      setStatus("signing");
      const s = await openTeeSession(signer.publicKey, wallet.signMessage);
      if (!stillCurrent()) {
        if (activeKey.current !== connectingKey) closeTeeSession(signer.publicKey);
        return;
      }
      setTee(s);
      setStatus("ready");
    } catch (e) {
      if (!stillCurrent()) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [signer, wallet.signMessage, setConnectOpen]);

  // Effects run after render: never expose a former wallet's connection meanwhile.
  const live = sessionMatchesWallet(tee, key) ? tee : null;
  const visibleStatus: TeeStatus = !signer ? "no-wallet" : live ? "ready" : status === "ready" ? "idle" : status;
  return { signer, base, tee: live, er: live?.connection ?? null, status: visibleStatus, error, connect };
}
