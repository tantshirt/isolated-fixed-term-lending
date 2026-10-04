"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { LazyMotion, MotionConfig, domMax } from "motion/react";
import type { ReactNode } from "react";
import { RPC_URL } from "@/lib/constants";
import { SignerProvider } from "@/lib/client/signer-context";
import { ToastProvider } from "@/lib/client/toast";

/**
 * Wallets register themselves through Wallet Standard (Phantom, Solflare, Backpack),
 * so no adapters are listed. Motion honours the OS reduced-motion setting everywhere.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={[]} autoConnect>
        <SignerProvider>
          <LazyMotion features={domMax} strict>
            <MotionConfig reducedMotion="user">
              <ToastProvider>{children}</ToastProvider>
            </MotionConfig>
          </LazyMotion>
        </SignerProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
