"use client";
import { useState } from "react";
import { useBalances, useDevConfig } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { NETWORK } from "@/lib/constants";
import { sendWrapSol } from "@/lib/transactions";
import { sendPythUpdate } from "@/lib/pyth";
import { parseAmount } from "@/lib/offer-validation";
import { exactAmount } from "@/lib/simulation";
import { SubmissionError, signatureUrl } from "@/lib/transaction-lifecycle";
import s from "./Experience.module.css";
export function DevnetSetup() {
  const { signer, publicKey, setConnectOpen, bumpRefresh } = useSigner();
  const { config, readiness, loaded } = useDevConfig();
  const balances = useBalances(publicKey, config);
  const [amount, setAmount] = useState("1.1"),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [signatures, setSignatures] = useState<string[]>([]);
  const run = async (action: "wrap" | "price") => {
    if (!signer) {
      setConnectOpen(true);
      return;
    }
    setBusy(true);
    setMessage(
      "Preparing transaction. Review each wallet request; confirmation may take a moment."
    );
    setSignatures([]);
    try {
      if (action === "wrap") {
        const atoms = parseAmount(amount, 9);
        if (!atoms || atoms <= 0n)
          throw new Error("Enter a positive SOL amount, up to 9 decimals.");
        setSignatures([await sendWrapSol(signer, atoms)]);
      } else {
        const result = await sendPythUpdate(signer);
        setSignatures(result.signatures);
      }
      setMessage("Confirmed on chain.");
      bumpRefresh();
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "The transaction could not complete."
      );
      if (e instanceof SubmissionError && e.signature)
        setSignatures([e.signature]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className={s.setup} open>
      <summary>
        {NETWORK === "devnet" ? "Devnet" : "Localnet"} setup ·{" "}
        {loaded
          ? readiness?.ready
            ? "Ready"
            : "Connection or price needs attention"
          : "Checking readiness…"}
      </summary>
      <p>
        Real wallet signatures, test tokens only. You can browse offers without
        connecting.
      </p>
      {loaded && !readiness?.ready && (
        <p role="status">
          {readiness?.errors?.join(" ") ||
            "Unable to verify network readiness. Retry the connection."}
        </p>
      )}
      <div className={s.actions}>
        <button className={s.secondary} onClick={bumpRefresh}>
          Retry connection
        </button>
        {!signer && (
          <button className={s.primary} onClick={() => setConnectOpen(true)}>
            Connect wallet
          </button>
        )}
        <a href="https://faucet.solana.com/" target="_blank" rel="noreferrer">
          Get test SOL ↗
        </a>
        <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">
          Get test USDC ↗
        </a>
      </div>
      {signer && (
        <>
          <p>
            {balances
              ? `${balances.sol.toFixed(4)} SOL · ${exactAmount(
                  balances.usdc,
                  6
                )} USDC · ${exactAmount(balances.wsol, 9)} wSOL`
              : "Reading wallet balances. Unavailable balances are not zero."}
          </p>
          <div className={s.actions}>
            <label>
              Additional SOL to wrap{" "}
              <input
                aria-label="SOL to wrap"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <button
              className={s.secondary}
              disabled={busy}
              onClick={() => run("wrap")}
            >
              Wrap SOL
            </button>
            <button
              className={s.secondary}
              disabled={busy}
              onClick={() => run("price")}
            >
              Refresh Pyth price
            </button>
          </div>
          <p>
            Wrapping retains rent and 0.01 SOL for fees. Pyth refresh can
            require multiple signatures and temporary rent. Refresh a stale
            price before borrowing or liquidating.
          </p>
        </>
      )}
      <p aria-live="polite">{message}</p>
      {signatures.map((sig) => (
        <p key={sig}>
          <a target="_blank" rel="noreferrer" href={signatureUrl(sig)}>
            View transaction on Explorer ↗
          </a>
        </p>
      ))}
    </details>
  );
}
