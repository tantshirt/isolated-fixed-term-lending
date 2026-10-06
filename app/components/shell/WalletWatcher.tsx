"use client";

import { PublicKey } from "@solana/web3.js";
import { useEffect, useRef } from "react";
import { closeTeeSession } from "@/lib/private/tee";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { shortKey } from "@/lib/format";

/**
 * When the connected wallet changes to a different one, every view reloads for the
 * new wallet and a toast says which wallet is now active. Disconnecting or switching
 * forgets the previous wallet's private sign-in.
 */
export function WalletWatcher() {
  const { publicKey, bumpRefresh } = useSigner();
  const toast = useToast();
  const last = useRef<string | null>(null);
  const key = publicKey?.toBase58() ?? null;
  useEffect(() => {
    const prev = last.current;
    last.current = key;
    // The private sign-in belongs to one wallet; leaving it forgets the token.
    if (prev && prev !== key) closeTeeSession(new PublicKey(prev));
    if (prev && key && prev !== key) {
      bumpRefresh();
      toast({ tone: "info", title: `Switched to ${shortKey(key)}`, detail: "Everything on screen now shows this wallet." });
    }
  }, [key, bumpRefresh, toast]);
  return null;
}
