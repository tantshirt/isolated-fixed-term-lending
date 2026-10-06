"use client";

import { useEffect, useRef } from "react";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { shortKey } from "@/lib/format";

/**
 * When the connected wallet changes to a different one, every view reloads for the
 * new wallet and a toast says which wallet is now active.
 */
export function WalletWatcher() {
  const { publicKey, bumpRefresh } = useSigner();
  const toast = useToast();
  const last = useRef<string | null>(null);
  const key = publicKey?.toBase58() ?? null;
  useEffect(() => {
    const prev = last.current;
    last.current = key;
    if (prev && key && prev !== key) {
      bumpRefresh();
      toast({ tone: "info", title: `Switched to ${shortKey(key)}`, detail: "Everything on screen now shows this wallet." });
    }
  }, [key, bumpRefresh, toast]);
  return null;
}
