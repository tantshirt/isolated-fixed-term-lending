"use client";

import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { LazyMotion, MotionConfig, domMax } from "motion/react";
import type { ReactNode } from "react";
import { rpcFetch } from "@/lib/rpc-fetch";
import { RPC_URL, WS_URL } from "@/lib/constants";
import { SignerProvider } from "@/lib/client/signer-context";
import { ToastProvider } from "@/lib/client/toast";
import { WalletWatcher } from "./WalletWatcher";

/**
 * Wallets register themselves through Wallet Standard (Phantom, Solflare, Backpack),
 * so no adapters are listed. Motion honours the OS reduced-motion setting everywhere.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider
      endpoint={RPC_URL}
      config={{
        wsEndpoint: WS_URL,
        disableRetryOnRateLimit: true,
        fetch: rpcFetch,
      }}
    >
      <WalletProvider wallets={[]} autoConnect>
        <SignerProvider>
          <LazyMotion features={domMax} strict>
            <MotionConfig reducedMotion="user">
              <ToastProvider>
                <WalletWatcher />
                {children}
              </ToastProvider>
            </MotionConfig>
          </LazyMotion>
        </SignerProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
