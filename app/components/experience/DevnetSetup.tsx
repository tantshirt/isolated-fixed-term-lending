"use client";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useBalances, useDevConfig } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { NETWORK } from "@/lib/constants";
import { sendWrapSol } from "@/lib/transactions";
import { sendPythUpdate } from "@/lib/pyth";
import { parseAmount } from "@/lib/offer-validation";
import { exactAmount } from "@/lib/simulation";
import { SubmissionError, signatureUrl } from "@/lib/transaction-lifecycle";
import { AssetIcon, AssetLabel } from "@/components/brand/AssetLabel";
import { Button } from "@/components/ui/Button";
import { shortKey } from "@/lib/format";
import s from "./DevnetSetup.module.css";
export function DevnetSetup() {
  const pathname = usePathname();
  const { signer, publicKey, setConnectOpen, bumpRefresh } = useSigner();
  const { config, readiness, loaded } = useDevConfig();
  const balances = useBalances(publicKey, config);
  const [copyMessage, setCopyMessage] = useState("");
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
  const state = !loaded ? "loading" : readiness?.ready ? "ready" : "attention";
  return (
    <details className={s.setup} open={pathname === "/devnet"}>
      <summary className={s.summary}>
        <span className={s.summaryTitle}>
          <span className={s.chevron} aria-hidden>
            ⌄
          </span>
          Prepare your wallet
        </span>
        <span className={s.network} data-state={state}>
          <span aria-hidden className={s.dot} />
          {NETWORK === "devnet" ? "Devnet" : "Localnet"} ·{" "}
          {state === "loading"
            ? "Checking"
            : state === "ready"
            ? "Connected"
            : "Needs attention"}
        </span>
      </summary>
      <div className={s.content}>
        <div className={s.intro}>
          <div>
            <h2>A little setup. Then you’re ready.</h2>
            <p>Use test SOL for network fees and test USDC to lend or repay.</p>
          </div>
          {!signer && (
            <Button onClick={() => setConnectOpen(true)}>Connect wallet</Button>
          )}
        </div>
        {loaded && !readiness?.ready && (
          <div className={s.notice}>
            <p role="status">
              {readiness?.errors?.join(" ") ||
                "The network is unavailable. Check your connection and try again."}
            </p>
            <Button variant="ghost" onClick={bumpRefresh}>
              {readiness?.errors?.length ? "Check again" : "Retry connection"}
            </Button>
          </div>
        )}
        {publicKey && (
          <div className={s.address}>
            <span>
              Send faucet tokens to{" "}
              <b className="address">{shortKey(publicKey.toBase58())}</b>
            </span>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(publicKey.toBase58());
                  setCopyMessage("Address copied");
                } catch {
                  setCopyMessage(
                    "Could not copy. Copy the address from your wallet."
                  );
                }
              }}
            >
              Copy address
            </button>
            <span role="status">{copyMessage}</span>
          </div>
        )}
        <div className={s.funding} aria-label="Devnet faucets">
          <a
            href="https://faucet.solana.com/"
            target="_blank"
            rel="noopener noreferrer"
            className={s.faucet}
          >
            <span className={s.asset}>
              <AssetIcon symbol="SOL" size={40} />
            </span>
            <span className={s.faucetText}>
              <strong>Get test SOL</strong>
              <span>Network fees & wrapped collateral</span>
              <small>Solana Faucet</small>
            </span>
            <span className={s.external} aria-hidden>
              ↗
            </span>
          </a>
          <a
            href="https://faucet.circle.com/"
            target="_blank"
            rel="noopener noreferrer"
            className={s.faucet}
          >
            <span className={s.asset}>
              <AssetIcon symbol="USDC" size={40} />
            </span>
            <span className={s.faucetText}>
              <strong>Get test USDC</strong>
              <span>Lending & loan repayment</span>
              <small>Circle Faucet</small>
            </span>
            <span className={s.external} aria-hidden>
              ↗
            </span>
          </a>
        </div>
        <p className={s.faucetHint}>
          Faucets open in a new tab. Choose <strong>Solana Devnet</strong> and
          use your connected wallet address.
        </p>
        {signer && (
          <>
            <div className={s.balanceHeader}>
              <h3>Your balances</h3>
              <button type="button" onClick={bumpRefresh}>
                Refresh balances
              </button>
            </div>
            <div className={s.balances}>
              <div>
                <AssetLabel symbol="SOL" />
                <strong>{balances ? balances.sol.toFixed(4) : "—"}</strong>
              </div>
              <div>
                <AssetLabel symbol="USDC" />
                <strong>
                  {balances ? exactAmount(balances.usdc, 6) : "—"}
                </strong>
              </div>
              <div>
                <AssetLabel symbol="wSOL" />
                <strong>
                  {balances ? exactAmount(balances.wsol, 9) : "—"}
                </strong>
              </div>
            </div>
            {!balances && (
              <p className={s.faucetHint}>
                Balances are loading or temporarily unavailable.
              </p>
            )}
            <details className={s.tools}>
              <summary>Prepare wSOL collateral & refresh the price</summary>
              <p>
                Borrowing uses wrapped SOL. Wrapping moves SOL into your own
                wSOL balance; it does not lock a loan.
              </p>
              <div className={s.wrap}>
                <label htmlFor="wrap-sol">Additional SOL to wrap</label>
                <div>
                  <input
                    id="wrap-sol"
                    aria-label="SOL to wrap"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => run("wrap")}
                  >
                    Wrap SOL
                  </Button>
                </div>
              </div>
              <p>
                Keep some SOL for fees. ZenLo retains rent and at least 0.01
                SOL.
              </p>
              <div className={s.price}>
                <div>
                  <h3>Live SOL price</h3>
                  <p>
                    Refresh a stale Pyth price before borrowing or liquidating.
                    This can require several wallet approvals and temporary
                    rent.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => run("price")}
                >
                  Refresh Pyth price
                </Button>
              </div>
            </details>
          </>
        )}
        {message && (
          <p className={s.feedback} aria-live="polite">
            {message}
          </p>
        )}
        {signatures.map((sig) => (
          <a
            className={s.receipt}
            key={sig}
            target="_blank"
            rel="noopener noreferrer"
            href={signatureUrl(sig)}
          >
            View transaction on Explorer ↗
          </a>
        ))}
      </div>
    </details>
  );
}
