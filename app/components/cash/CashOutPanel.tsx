"use client";

import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { useBackendSession } from "@/lib/auth/wallet-session";
import { capabilityFor, DEVNET_USDC } from "@/lib/capabilities";
import { CASH_OUT_WORDS, RAMPS, SANDBOX_CASH_OUT_WORDS, reviewSignPayload, type ReviewedTransfer, type SignPayload } from "@/lib/cash/moneygram";
import { useSigner } from "@/lib/client/signer-context";
import { formatUsdc, shortKey } from "@/lib/format";
import { getConnection } from "@/lib/program";
import { submitTransaction } from "@/lib/transaction-lifecycle";
import styles from "./CashOut.module.css";

const BACKEND = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);
const ENV = (process.env.NEXT_PUBLIC_MONEYGRAM_ENV === "production" ? "production" : "sandbox") as "sandbox" | "production";

type RampsInstance = { open: () => void; destroy: () => void };
declare global {
  interface Window {
    RampsSDK?: { createRamps: (config: Record<string, unknown>) => RampsInstance };
  }
}

function loadSdk(src: string): Promise<void> {
  if (window.RampsSDK) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("MoneyGram's widget did not load."));
    document.head.appendChild(s);
  });
}

/**
 * MoneyGram sandbox cash-out (Story 24.4). Not private: MoneyGram runs its own ID checks and sees
 * the transfer. ZenLo creates the session server-side, reviews every transfer MoneyGram asks the
 * wallet to sign, and keeps only ids and status.
 */
export function CashOutPanel({ usdcBalance }: { usdcBalance: bigint | null }) {
  const capability = capabilityFor("moneygram", "devnet", DEVNET_USDC, "cash-out");
  return (
    <section className={styles.panel} aria-labelledby="cash-h">
      <h2 id="cash-h">Cash out with MoneyGram</h2>
      <ul className={styles.disclosures}>
        <li>
          <strong>This step is not private.</strong> MoneyGram checks your identity in its own window and sees the transfer. ZenLo keeps only the
          transaction ids and status.
        </li>
        <li>MoneyGram decides which countries, agents and fees apply, and shows them before you confirm.</li>
        <li>Cash-out only for now. If you borrowed, you still need USDC to repay; cash-in is not available here.</li>
        <li>{ENV === "sandbox" ? "Sandbox: no real cash is ever paid out." : "Production cash-out."}</li>
      </ul>
      {!capability.available ? <p className={styles.unavailable}>{capability.reason}</p> : BACKEND ? <Live usdcBalance={usdcBalance} /> : null}
    </section>
  );
}

function Live({ usdcBalance }: { usdcBalance: bigint | null }) {
  const session = useBackendSession();
  const { signer } = useSigner();
  const signedIn = session.status === "signed-in";
  const created = useMutation(api.cash.recordCreated);
  const signed = useMutation(api.cash.recordSigned);
  const reference = useMutation(api.cash.recordReference);
  const history = useQuery(api.cash.myCashOuts, signedIn ? {} : "skip");
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<RampsInstance | null>(null);
  const rampsId = useRef<string | null>(null);
  const [review, setReview] = useState<{ transfer: ReviewedTransfer; resolve: (sig: string) => void; reject: (e: Error) => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openButton = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const words = ENV === "sandbox" ? SANDBOX_CASH_OUT_WORDS : CASH_OUT_WORDS;

  useEffect(() => () => widget.current?.destroy(), []);
  useEffect(() => {
    if (review) dialog.current?.focus();
  }, [review]);

  const cancel = () => {
    review?.reject(new Error("Cancelled by user"));
    setReview(null);
    openButton.current?.querySelector("button")?.focus();
  };

  const open = async () => {
    setError(null);
    setBusy(true);
    try {
      if (!signer) throw new Error("Connect a wallet first.");
      const res = await session.authorizedPost("/cash/session");
      const body = (await res.json()) as { sessionToken?: string; widgetUrl?: string; error?: string };
      if (!res.ok || !body.sessionToken) throw new Error(body.error ?? "MoneyGram is unavailable right now.");
      await loadSdk(RAMPS[ENV].sdk);
      widget.current?.destroy();
      widget.current = window.RampsSDK!.createRamps({
        container: container.current,
        sessionToken: body.sessionToken,
        widgetUrl: body.widgetUrl,
        wallet: { address: signer.publicKey.toBase58(), chain: "solana", asset: "USDC", walletType: "non-custodial", displayName: "ZenLo" },
        onTransactionCreated: async (tx: { id: string; mgiTransactionId?: string; amount?: number }) => {
          rampsId.current = tx.id;
          await created({ rampsId: tx.id, mgiTransactionId: tx.mgiTransactionId, amount: tx.amount !== undefined ? String(tx.amount) : undefined });
        },
        // MoneyGram waits on this promise. The transfer is checked, then shown for approval.
        onSignTransaction: (tx: SignPayload) =>
          new Promise<string>((resolve, reject) => {
            if (usdcBalance === null) {
              const reason = "Your USDC balance has not loaded yet. Try again.";
              setError(reason);
              return reject(new Error(reason));
            }
            const checked = reviewSignPayload(tx, ENV, usdcBalance);
            if (!checked.ok) {
              setError(checked.reason);
              return reject(new Error(checked.reason));
            }
            setReview({ transfer: checked.transfer, resolve, reject });
          }),
        onComplete: async (tx: { id: string; referenceNumber?: string }) => {
          if (tx.referenceNumber) await reference({ rampsId: tx.id, referenceNumber: tx.referenceNumber });
        },
        onError: (e: { reason?: string }) => setError(e.reason ?? "MoneyGram reported an error."),
      });
      widget.current.open();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open MoneyGram.");
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!review || !signer) return;
    const { transfer, resolve, reject } = review;
    setBusy(true);
    try {
      const mint = new PublicKey(transfer.mint);
      const to = new PublicKey(transfer.to);
      const from = getAssociatedTokenAddressSync(mint, signer.publicKey);
      const toAta = getAssociatedTokenAddressSync(mint, to, true);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, toAta, to, mint),
        createTransferCheckedInstruction(from, mint, toAta, signer.publicKey, transfer.atoms, transfer.decimals),
      );
      const signature = await submitTransaction(getConnection(), signer, tx);
      if (rampsId.current) await signed({ rampsId: rampsId.current, signature, amountAtoms: transfer.atoms.toString(), depositAddress: transfer.to });
      setReview(null);
      openButton.current?.querySelector("button")?.focus();
      resolve(signature);
    } catch (e) {
      setReview(null);
      reject(e instanceof Error ? e : new Error("Signing failed"));
    } finally {
      setBusy(false);
    }
  };

  if (!signedIn)
    return (
      <Button variant="secondary" loading={session.status === "signing"} onClick={() => session.signIn()} disabled={session.status === "no-wallet"}>
        Sign in to cash out
      </Button>
    );

  return (
    <>
      <div ref={openButton}>
        <Button onClick={open} loading={busy && !review}>
          Open MoneyGram
        </Button>
      </div>
      {review && (
        <div
          ref={dialog}
          className={styles.review}
          role="dialog"
          aria-modal="true"
          aria-labelledby="cash-review-h"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) cancel();
          }}
        >
          <h3 id="cash-review-h">Check this transfer</h3>
          <p className={styles.note}>
            Not private: MoneyGram sees this transfer.{ENV === "sandbox" ? " Sandbox: no real cash is paid out." : ""}
          </p>
          <dl>
            <div>
              <dt>You send</dt>
              <dd className="num">{formatUsdc(review.transfer.atoms)} USDC</dd>
            </div>
            <div>
              <dt>To MoneyGram</dt>
              <dd className="mono">{shortKey(review.transfer.to)}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>{review.transfer.network === "testnet" ? "Solana Devnet" : "Solana mainnet"}</dd>
            </div>
          </dl>
          <div className={styles.row}>
            <Button variant="ghost" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
            <Button loading={busy} onClick={approve}>
              Approve and sign
            </Button>
          </div>
        </div>
      )}
      <div ref={container} className={styles.widget} />
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div aria-live="polite">
        {history && history.length > 0 && (
          <>
            <h3 className={styles.historyTitle}>{ENV === "sandbox" ? "Your cash-outs (sandbox)" : "Your cash-outs"}</h3>
            <ul className={styles.history}>
              {history.map((h) => (
                <li key={h.rampsId}>
                  <span>{words[h.status] ?? h.status}</span>
                  {h.amountAtoms && <span className="num">{formatUsdc(BigInt(h.amountAtoms))} USDC</span>}
                  {h.referenceNumber && (
                    <span>
                      {ENV === "sandbox" ? "Sandbox reference" : "Reference"} <span className="mono">{h.referenceNumber}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
