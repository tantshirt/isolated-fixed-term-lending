"use client";

import { Button } from "@/components/ui/Button";
import type { TeeStatus } from "@/lib/private/use-private";
import styles from "./private.module.css";

const COPY: Record<TeeStatus, { title: string; body: string }> = {
  "no-wallet": { title: "Connect a wallet", body: "Private rooms are tied to your Devnet wallet. No account or email." },
  "no-sign-message": {
    title: "This wallet cannot sign messages",
    body: "Signing in to the private rollup needs a wallet that can sign a message, such as Phantom, Solflare, or Backpack.",
  },
  idle: {
    title: "Check the private rollup, then sign in",
    body: "Lendspan first verifies the rollup's hardware attestation, then asks your wallet to sign a one-time message. Nothing is sent or spent.",
  },
  verifying: { title: "Verifying the private rollup", body: "Checking the TEE's Intel TDX attestation before any private request." },
  signing: { title: "Approve the sign-in in your wallet", body: "This proves you own the wallet. It is not a transaction." },
  ready: { title: "Connected privately", body: "Attestation verified. Only you and the members you invite can read your rooms." },
  error: { title: "Could not connect privately", body: "Nothing private was sent. You can try again." },
};

export function TeeCard({ status, error, onConnect }: { status: TeeStatus; error: string | null; onConnect: () => void }) {
  const c = COPY[status];
  const busy = status === "verifying" || status === "signing";
  return (
    <section className={styles.tee} data-status={status} aria-live="polite">
      <span className={styles.teeIcon} aria-hidden>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <rect x="4" y="8.5" width="12" height="8.5" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M7 8.5V6.2a3 3 0 0 1 6 0v2.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          {status === "ready" && <path d="m7.6 12.8 1.7 1.6 3.2-3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      </span>
      <div className={styles.teeText}>
        <h2 className={styles.teeTitle}>{c.title}</h2>
        <p className={styles.teeBody}>{status === "error" && error ? `${c.body} (${error})` : c.body}</p>
      </div>
      {status !== "ready" && status !== "no-sign-message" && (
        <Button onClick={onConnect} loading={busy} variant={status === "no-wallet" ? "secondary" : "primary"}>
          {status === "no-wallet" ? "Connect wallet" : status === "error" ? "Try again" : "Verify and sign in"}
        </Button>
      )}
    </section>
  );
}
