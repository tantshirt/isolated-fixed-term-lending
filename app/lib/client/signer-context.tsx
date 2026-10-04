"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { STORAGE_KEYS, type ActingRole } from "@/lib/constants";
import { KeypairWallet, type LoanSigner } from "@/lib/keypair-wallet";
import { hasRoleKeypairs, keypairForRole, setActiveRole } from "@/lib/roles";

export type SignerSource = "wallet" | "local" | "none";

type SignerState = {
  signer: LoanSigner | null;
  publicKey: PublicKey | null;
  source: SignerSource;
  /** Which demo wallet is active, when source is "local". */
  localRole: ActingRole | null;
  walletName: string | null;
  chooseLocal: (role: ActingRole) => void;
  disconnect: () => Promise<void>;
  /** Bumped after funding or setup so balance readers refetch. */
  refreshKey: number;
  bumpRefresh: () => void;
  connectOpen: boolean;
  setConnectOpen: (open: boolean) => void;
  deskOpen: boolean;
  setDeskOpen: (open: boolean) => void;
};

const SignerContext = createContext<SignerState | null>(null);

function readStoredLocalRole(): ActingRole | null {
  try {
    if (localStorage.getItem(STORAGE_KEYS.signerSource) !== "local") return null;
    const role = localStorage.getItem(STORAGE_KEYS.role);
    return role === "lender" || role === "borrower" || role === "liquidator" ? role : null;
  } catch {
    return null;
  }
}

/**
 * One signer for the whole app. A browser wallet wins when it connects; picking a
 * demo wallet on the desk overrides it until the person disconnects.
 */
export function SignerProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const [localRole, setLocalRole] = useState<ActingRole | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [connectOpen, setConnectOpen] = useState(false);
  const [deskOpen, setDeskOpen] = useState(false);

  useEffect(() => {
    if (hasRoleKeypairs()) setLocalRole(readStoredLocalRole());
  }, []);

  // A wallet that connects after a demo wallet was picked takes over.
  useEffect(() => {
    if (wallet.connected && wallet.publicKey) {
      setLocalRole(null);
      try {
        localStorage.setItem(STORAGE_KEYS.signerSource, "wallet");
      } catch {}
    }
  }, [wallet.connected, wallet.publicKey]);

  const chooseLocal = useCallback(
    (role: ActingRole) => {
      setActiveRole(role);
      try {
        localStorage.setItem(STORAGE_KEYS.signerSource, "local");
      } catch {}
      setLocalRole(role);
      if (wallet.connected) void wallet.disconnect();
    },
    [wallet],
  );

  const disconnect = useCallback(async () => {
    setLocalRole(null);
    try {
      localStorage.removeItem(STORAGE_KEYS.signerSource);
    } catch {}
    if (wallet.connected) await wallet.disconnect();
  }, [wallet]);

  const value = useMemo<SignerState>(() => {
    let signer: LoanSigner | null = null;
    let source: SignerSource = "none";
    const local = localRole ? keypairForRole(localRole) : null;
    if (local) {
      signer = new KeypairWallet(local);
      source = "local";
    } else if (
      wallet.connected &&
      wallet.publicKey &&
      wallet.signTransaction &&
      wallet.signAllTransactions
    ) {
      signer = {
        publicKey: wallet.publicKey,
        signTransaction: wallet.signTransaction,
        signAllTransactions: wallet.signAllTransactions,
      };
      source = "wallet";
    }
    return {
      signer,
      publicKey: signer?.publicKey ?? null,
      source,
      localRole: source === "local" ? localRole : null,
      walletName: source === "wallet" ? (wallet.wallet?.adapter.name ?? null) : null,
      chooseLocal,
      disconnect,
      refreshKey,
      bumpRefresh: () => setRefreshKey((k) => k + 1),
      connectOpen,
      setConnectOpen,
      deskOpen,
      setDeskOpen,
    };
  }, [localRole, wallet, chooseLocal, disconnect, refreshKey, connectOpen, deskOpen]);

  return <SignerContext.Provider value={value}>{children}</SignerContext.Provider>;
}

export function useSigner(): SignerState {
  const ctx = useContext(SignerContext);
  if (!ctx) throw new Error("useSigner outside SignerProvider");
  return ctx;
}
