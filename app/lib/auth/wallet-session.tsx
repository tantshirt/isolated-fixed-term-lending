"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { base58 } from "@scure/base";
import nacl from "tweetnacl";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { useSigner } from "@/lib/client/signer-context";
import { KeypairWallet } from "@/lib/keypair-wallet";
import { SessionScope } from "./session-scope";

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL;
const SITE_URL = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
const storageKey = (wallet: string) => `zenlo:session:${wallet}`;

export type SessionStatus = "unavailable" | "no-wallet" | "no-sign-message" | "signed-out" | "signing" | "signed-in" | "error";

type SessionState = {
  status: SessionStatus;
  wallet: string | null;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** POSTs to a Convex HTTP route with this wallet's session token. */
  authorizedPost: (path: string, body?: unknown) => Promise<Response>;
};

const SessionContext = createContext<SessionState | null>(null);

function readStored(wallet: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(wallet));
  } catch {
    return null;
  }
}
function writeStored(wallet: string, token: string | null) {
  try {
    if (token) sessionStorage.setItem(storageKey(wallet), token);
    else sessionStorage.removeItem(storageKey(wallet));
  } catch {
    // Storage can be blocked; the session then lasts until reload.
  }
}

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${SITE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

/**
 * Backend sign-in for the connected wallet. It never prompts by itself: a feature that needs the
 * backend calls `signIn()`. Changing wallets ends the previous wallet's session immediately.
 */
function SessionProvider({ children, onToken }: { children: ReactNode; onToken: (t: { wallet: string; token: string } | null) => void }) {
  const { signer, source } = useSigner();
  const wallet = useWallet();
  const key = signer?.publicKey.toBase58() ?? null;
  const [token, setToken] = useState<{ wallet: string; token: string } | null>(null);
  const scope = useRef(new SessionScope());
  scope.current.setWallet(key);
  useEffect(() => () => scope.current.invalidate(), []);
  const [status, setStatus] = useState<SessionStatus>(CONVEX_URL ? "no-wallet" : "unavailable");
  const [error, setError] = useState<string | null>(null);
  const current = useRef<{ wallet: string; token: string } | null>(null);

  useEffect(() => {
    const previous = current.current;
    if (previous && previous.wallet !== key) {
      void post("/auth/signout", {}, previous.token).catch(() => {});
      writeStored(previous.wallet, null);
    }
    const stored = key ? readStored(key) : null;
    current.current = key && stored ? { wallet: key, token: stored } : null;
    setToken(current.current);
    setError(null);
    if (!CONVEX_URL) setStatus("unavailable");
    else if (!key) setStatus("no-wallet");
    else if (stored) setStatus("signed-in");
    else if (source === "wallet" && !wallet.signMessage) setStatus("no-sign-message");
    else setStatus("signed-out");
  }, [key, source, wallet.signMessage]);

  useEffect(() => onToken(token?.wallet === key ? token : null), [key, token, onToken]);

  const signMessage = useCallback(
    async (message: Uint8Array): Promise<Uint8Array> => {
      if (signer instanceof KeypairWallet) return nacl.sign.detached(message, signer.keypair.secretKey);
      if (!wallet.signMessage) throw new Error("This wallet cannot sign messages.");
      return wallet.signMessage(message);
    },
    [signer, wallet],
  );

  const signIn = useCallback(async () => {
    if (!CONVEX_URL || !key) return;
    const signingFor = key;
    const attempt = scope.current.begin();
    setStatus("signing");
    setError(null);
    try {
      const challenge = await post("/auth/challenge", { wallet: signingFor });
      if (!challenge.ok) throw new Error("Sign-in is not available on this site right now.");
      const { nonce, message } = (await challenge.json()) as { nonce: string; message: string };
      if (!scope.current.isCurrent(attempt)) return;
      const signature = base58.encode(await signMessage(new TextEncoder().encode(message)));
      if (!scope.current.isCurrent(attempt)) return;
      const verified = await post("/auth/verify", { wallet: signingFor, nonce, signature });
      if (!verified.ok) throw new Error("The signature was not accepted. Try again.");
      const { token: issued } = (await verified.json()) as { token: string };
      if (!scope.current.isCurrent(attempt)) {
        void post("/auth/signout", {}, issued).catch(() => {});
        return;
      }
      current.current = { wallet: signingFor, token: issued };
      writeStored(signingFor, issued);
      setToken(current.current);
      setStatus("signed-in");
    } catch (e) {
      if (!scope.current.isCurrent(attempt)) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    }
  }, [key, signMessage]);

  const signOut = useCallback(async () => {
    scope.current.invalidate();
    const live = current.current;
    current.current = null;
    setToken(null);
    setStatus(key ? "signed-out" : "no-wallet");
    if (live) {
      writeStored(live.wallet, null);
      await post("/auth/signout", {}, live.token).catch(() => {});
    }
  }, [key]);

  const authorizedPost = useCallback(
    async (path: string, body: unknown = {}) => {
      const live = current.current;
      if (!live) throw new Error("Sign in first.");
      return post(path, body, live.token);
    },
    [],
  );

  const value = useMemo(() => ({ status, wallet: key, error, signIn, signOut, authorizedPost }), [status, key, error, signIn, signOut, authorizedPost]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Wraps the Devnet shell. Without a configured Convex URL, the backend is simply unavailable. */
export function BackendProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => (CONVEX_URL ? new ConvexReactClient(CONVEX_URL) : null), []);
  const live = useRef<{ wallet: string; token: string } | null>(null);
  const [version, setVersion] = useState(0);
  const onToken = useCallback((t: { wallet: string; token: string } | null) => {
    if (live.current?.token === t?.token) return;
    live.current = t;
    setVersion((v) => v + 1);
  }, []);

  const useAuth = useCallback(
    function useAuth() {
      return useMemo(
        () => ({
          isLoading: false,
          isAuthenticated: live.current !== null,
          fetchAccessToken: async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
            const t = live.current;
            if (!t) return null;
            if (!forceRefreshToken) return t.token;
            const res = await post("/auth/refresh", {}, t.token).catch(() => null);
            if (!res?.ok || live.current?.wallet !== t.wallet) {
              writeStored(t.wallet, null);
              return null;
            }
            const { token } = (await res.json()) as { token: string };
            live.current = { wallet: t.wallet, token };
            writeStored(t.wallet, token);
            return token;
          },
        }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [version],
      );
    },
    [version],
  );

  if (!client) return <SessionProvider onToken={onToken}>{children}</SessionProvider>;
  return (
    <ConvexProviderWithAuth client={client} useAuth={useAuth}>
      <SessionProvider onToken={onToken}>{children}</SessionProvider>
    </ConvexProviderWithAuth>
  );
}

export function useBackendSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useBackendSession must be used inside BackendProvider");
  return ctx;
}
