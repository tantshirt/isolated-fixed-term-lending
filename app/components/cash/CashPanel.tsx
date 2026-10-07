"use client";

import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { useBackendSession } from "@/lib/auth/wallet-session";
import { capabilityFor, DEVNET_USDC } from "@/lib/capabilities";
import {
  CASH_IN_WORDS,
  CASH_OUT_WORDS,
  RAMPS,
  SANDBOX_CASH_IN_WORDS,
  SANDBOX_CASH_OUT_WORDS,
  cashInShortfall,
  cashWidgetConfig,
  createdTransactionError,
  reviewSignPayload,
  type CashDirection,
  type ReviewedTransfer,
  type SignPayload,
} from "@/lib/cash/moneygram";
import { useSigner } from "@/lib/client/signer-context";
import { formatUsdc, shortKey } from "@/lib/format";
import { getConnection } from "@/lib/program";
import { submitCashTransfer } from "@/lib/cash/transfer";
import styles from "./CashOut.module.css";

const BACKEND = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);
const ENV = (process.env.NEXT_PUBLIC_MONEYGRAM_ENV === "production" ? "production" : "sandbox") as "sandbox" | "production";
const SANDBOX = ENV === "sandbox";

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

type Props = {
  direction: CashDirection;
  usdcBalance: bigint | null;
  /** Cash-in only: what this loan needs to close, so the panel can say how much USDC is missing. */
  payoffAtoms?: bigint | null;
  /** Inside a loan's side column rather than at the foot of a page. */
  compact?: boolean;
};

/**
 * MoneyGram sandbox cash-out (Story 24.4) and cash-in (Story 26.5). Not private: MoneyGram runs
 * its own ID checks and sees the transfer. ZenLo creates the session server-side for the signed-in
 * wallet, reviews every transfer MoneyGram asks the wallet to sign, and keeps only ids and status.
 * Cash-in only lands USDC in the wallet; it never repays a loan. Repaying stays a separate signed step.
 */
export function CashPanel({ direction, usdcBalance, payoffAtoms = null, compact = false }: Props) {
  const capability = capabilityFor("moneygram", "devnet", DEVNET_USDC, direction === "in" ? "cash-in" : "cash-out");
  const cashInOn = capabilityFor("moneygram", "devnet", DEVNET_USDC, "cash-in").available;
  const headingId = `cash-${direction}-h`;
  const shortfall = direction === "in" && payoffAtoms !== null ? cashInShortfall(payoffAtoms, usdcBalance) : null;
  return (
    <section className={`${styles.panel} ${compact ? styles.compact : ""}`} aria-labelledby={headingId}>
      <h2 id={headingId}>{direction === "in" ? "Fund this repayment with cash" : "Cash out with MoneyGram"}</h2>
      {direction === "in" ? (
        <ul className={styles.disclosures}>
          <li>
            <strong>This step is not private.</strong> MoneyGram checks your identity in its own window and sees the deposit. ZenLo keeps only the
            transaction ids and status.
          </li>
          <li>You pay cash at a MoneyGram agent and MoneyGram sends USDC to this wallet. MoneyGram decides which countries, agents and fees apply, and shows them before you confirm.</li>
          <li>
            <strong>It does not repay your loan.</strong> Once the USDC arrives, repaying stays a separate step that you review and sign.
          </li>
          <li>{SANDBOX ? "Sandbox: no real cash is taken, and only test USDC arrives." : "Production cash-in."}</li>
        </ul>
      ) : (
        <ul className={styles.disclosures}>
          <li>
            <strong>This step is not private.</strong> MoneyGram checks your identity in its own window and sees the transfer. ZenLo keeps only the
            transaction ids and status.
          </li>
          <li>MoneyGram decides which countries, agents and fees apply, and shows them before you confirm.</li>
          <li>
            {cashInOn
              ? "If you borrowed, you still need USDC to repay. You can fund a repayment with cash from the loan's page."
              : "Cash-out only for now. If you borrowed, you still need USDC to repay; cash-in is not available here."}
          </li>
          <li>{SANDBOX ? "Sandbox: no real cash is ever paid out." : "Production cash-out."}</li>
        </ul>
      )}
      {shortfall !== null && (
        <p className={`${styles.note} num`}>
          {shortfall > 0n ? `To repay from this wallet you need ${formatUsdc(shortfall)} USDC more.` : "This wallet already holds enough USDC to repay."}
        </p>
      )}
      {!capability.available ? (
        <p className={styles.unavailable}>{capability.reason}</p>
      ) : BACKEND ? (
        <Live direction={direction} usdcBalance={usdcBalance} />
      ) : (
        <p className={styles.unavailable}>{direction === "in" ? "Cash-in" : "Cash-out"} needs the ZenLo backend, which is not connected on this deployment.</p>
      )}
    </section>
  );
}

function Live({ direction, usdcBalance }: { direction: CashDirection; usdcBalance: bigint | null }) {
  const session = useBackendSession();
  const { signer } = useSigner();
  const signedIn = session.status === "signed-in";
  const created = useMutation(api.cash.recordCreated);
  const signed = useMutation(api.cash.recordSigned);
  const reference = useMutation(api.cash.recordReference);
  const history = useQuery(api.cash.myCashOuts, signedIn ? { direction } : "skip");
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<RampsInstance | null>(null);
  const rampsId = useRef<string | null>(null);
  const creation = useRef<Promise<unknown> | null>(null);
  const [review, setReview] = useState<{ rampsId: string; wallet: string; transfer: ReviewedTransfer; resolve: (sig: string) => void; reject: (e: Error) => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openButton = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const cashIn = direction === "in";
  const words = cashIn ? (SANDBOX ? SANDBOX_CASH_IN_WORDS : CASH_IN_WORDS) : SANDBOX ? SANDBOX_CASH_OUT_WORDS : CASH_OUT_WORDS;

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
      if (!res.ok || !body.sessionToken || !body.widgetUrl) throw new Error(body.error ?? "MoneyGram is unavailable right now.");
      await loadSdk(RAMPS[ENV].sdk);
      widget.current?.destroy();
      rampsId.current = null;
      creation.current = null;
      widget.current = window.RampsSDK!.createRamps({
        container: container.current,
        sessionToken: body.sessionToken,
        ...cashWidgetConfig(direction, body.widgetUrl),
        wallet: { address: signer.publicKey.toBase58(), chain: "solana", asset: "USDC", walletType: "non-custodial", displayName: "ZenLo" },
        onTransactionCreated: async (tx: { id: string; type?: string; chain?: string; asset?: string; walletAddress?: string; mgiTransactionId?: string; amount?: number }) => {
          const mismatch = createdTransactionError(tx, direction, signer.publicKey.toBase58());
          if (mismatch) {
            rampsId.current = null;
            creation.current = null;
            setError(mismatch);
            return;
          }
          rampsId.current = tx.id;
          creation.current = created({ rampsId: tx.id, mgiTransactionId: tx.mgiTransactionId, amount: tx.amount !== undefined ? String(tx.amount) : undefined, direction });
          await creation.current;
        },
        // MoneyGram waits on this promise. The transfer is checked, then shown for approval.
        onSignTransaction: (tx: SignPayload) =>
          new Promise<string>((resolve, reject) => {
            if (cashIn) {
              // A deposit sends USDC to this wallet. Nothing should ever leave it.
              const reason = "Cash-in never asks your wallet to send funds, so this request was refused.";
              setError(reason);
              return reject(new Error(reason));
            }
            if (!rampsId.current || !creation.current) return reject(new Error("MoneyGram has not created this cash-out yet."));
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
            setReview({ rampsId: rampsId.current, wallet: signer.publicKey.toBase58(), transfer: checked.transfer, resolve, reject });
          }),
        onComplete: async (tx: { id: string; referenceNumber?: string }) => {
          if (tx.id !== rampsId.current || !creation.current) return;
          await creation.current;
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
    const { transfer, resolve, reject, wallet, rampsId: reviewedId } = review;
    setBusy(true);
    try {
      if (signer.publicKey.toBase58() !== wallet || session.wallet !== wallet) throw new Error("The wallet changed. Open MoneyGram again with the intended wallet.");
      await creation.current;
      const mint = new PublicKey(transfer.mint);
      const to = new PublicKey(transfer.to);
      const from = getAssociatedTokenAddressSync(mint, signer.publicKey);
      const toAta = getAssociatedTokenAddressSync(mint, to, true);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, toAta, to, mint),
        createTransferCheckedInstruction(from, mint, toAta, signer.publicKey, transfer.atoms, transfer.decimals),
      );
      const signature = await submitCashTransfer(getConnection(), signer, tx, reviewedId, ENV, transfer,
        (signature) => signed({ rampsId: reviewedId, signature, amountAtoms: transfer.atoms.toString(), depositAddress: transfer.to }));
      setReview(null);
      openButton.current?.querySelector("button")?.focus();
      resolve(signature);
    } catch (e) {
      setReview(null);
      setError(e instanceof Error ? e.message : "Signing failed");
      reject(e instanceof Error ? e : new Error("Signing failed"));
    } finally {
      setBusy(false);
    }
  };

  if (!signedIn)
    return (
      <Button variant="secondary" loading={session.status === "signing"} onClick={() => session.signIn()} disabled={session.status === "no-wallet"}>
        {cashIn ? "Sign in to add cash" : "Sign in to cash out"}
      </Button>
    );

  const arrived = cashIn && history?.some((h) => h.status === "completed");

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
            Not private: MoneyGram sees this transfer.{SANDBOX ? " Sandbox: no real cash is paid out." : ""}
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
        {arrived && <p className={styles.note}>MoneyGram reports the USDC was sent to this wallet. Check your balance, then review and sign the repayment yourself; ZenLo never repays for you.</p>}
        {history && history.length > 0 && (
          <>
            <h3 className={styles.historyTitle}>
              {cashIn ? (SANDBOX ? "Your cash-ins (sandbox)" : "Your cash-ins") : SANDBOX ? "Your cash-outs (sandbox)" : "Your cash-outs"}
            </h3>
            <ul className={styles.history}>
              {history.map((h) => (
                <li key={h.rampsId}>
                  <span>{words[h.status] ?? h.status}</span>
                  {h.amountAtoms && <span className="num">{formatUsdc(BigInt(h.amountAtoms))} USDC</span>}
                  {h.referenceNumber && (
                    <span>
                      {SANDBOX ? "Sandbox reference" : "Reference"} <span className="mono">{h.referenceNumber}</span>
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
