"use client";

import type { Connection } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { messageFromAnchorError } from "@/lib/anchor-errors";
import { DEVNET_USDC_MINT, NATIVE_WSOL_MINT } from "@/lib/constants";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { depositPrivately, readPrivateBalance, withdrawPrivately, type PrivateBalanceState } from "@/lib/private/balances";
import { sendPrivately } from "@/lib/private/transfers";
import { PublicKey } from "@solana/web3.js";
import styles from "./private.module.css";

const TOKENS = {
  USDC: { mint: DEVNET_USDC_MINT, decimals: 6, wallet: "In your wallet", hint: "Lenders lock USDC; borrowers receive and repay it." },
  wSOL: { mint: NATIVE_WSOL_MINT, decimals: 9, wallet: "SOL available to wrap", hint: "Borrowers lock wSOL (wrapped SOL) as collateral. It is wrapped from your SOL as you deposit." },
} as const;
type TokenName = keyof typeof TOKENS;

const fmt = (atoms: bigint | null, decimals: number) =>
  atoms === null ? "—" : (Number(atoms) / 10 ** decimals).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: decimals });

export function BalancePanel({ signer, base, er, onChange }: { signer: LoanSigner | null; base: Connection; er: Connection | null; onChange: () => void }) {
  const [token, setToken] = useState<TokenName>("USDC");
  const t = TOKENS[token];
  const [state, setState] = useState<PrivateBalanceState | null>(null);
  const [amount, setAmount] = useState("0.10");
  const [busy, setBusy] = useState<"deposit" | "withdraw" | "send" | null>(null);
  const [to, setTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const key = signer?.publicKey.toBase58() ?? null;
  const current = useRef(key);
  current.current = key;
  const refresh = useCallback(async () => {
    if (!signer) return setState(null);
    const asked = signer.publicKey.toBase58();
    let next: PrivateBalanceState | null = null;
    try {
      next = await readPrivateBalance(base, er, signer.publicKey, t.mint);
    } catch {
      next = null;
    }
    if (current.current === asked) setState(next); // drop reads for a wallet that was switched away
  }, [signer, base, er, t.mint]);
  useEffect(() => void refresh(), [refresh]);

  // A different wallet never inherits the previous one's draft or messages.
  useEffect(() => {
    setMessage(null);
    setTo("");
    setSendAmount("");
    setState(null);
  }, [key]);

  const atoms = (() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 10 ** t.decimals)) : 0n;
  })();

  const toKey = (() => {
    try {
      return to.trim() ? new PublicKey(to.trim()) : null;
    } catch {
      return null;
    }
  })();
  const sendAtoms = (() => {
    const n = Number(sendAmount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 10 ** t.decimals)) : 0n;
  })();

  function chooseToken(k: TokenName) {
    setToken(k);
    setAmount(k === "USDC" ? "0.10" : "0.01");
    setSendAmount("");
    setMessage(null);
  }

  async function send() {
    if (!signer || !er || !toKey) return;
    setBusy("send");
    setMessage(null);
    try {
      await sendPrivately(er, signer, t.mint, t.decimals, toKey, sendAtoms);
      setMessage({ tone: "ok", text: "Sent inside the private rollup. Nothing appeared on Solana." });
      setSendAmount("");
      onChange();
      await refresh();
    } catch (e) {
      setMessage({ tone: "error", text: messageFromAnchorError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function run(kind: "deposit" | "withdraw") {
    if (!signer || !er) return;
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === "deposit") await depositPrivately(base, er, signer, t.mint, atoms);
      else await withdrawPrivately(base, er, signer, t.mint);
      setMessage({ tone: "ok", text: kind === "deposit" ? "Deposited. Your balance is now private." : "Withdrawn to your wallet." });
      onChange();
      await refresh();
    } catch (e) {
      setMessage({ tone: "error", text: messageFromAnchorError(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.panelBody}>
      <div className={styles.tokenSwitch} role="group" aria-label="Token">
        {(Object.keys(TOKENS) as TokenName[]).map((k) => (
          <button type="button" key={k} aria-pressed={token === k} onClick={() => chooseToken(k)}>
            {k}
          </button>
        ))}
      </div>
      <dl className={styles.balances}>
        <div>
          <dt>Private {token}</dt>
          <dd className={er ? "num" : undefined}>{er ? fmt(state?.privateAmount ?? (state?.exists ? 0n : null), t.decimals) : <span className={styles.pending}>Private until you sign in</span>}</dd>
        </div>
        <div>
          <dt>{t.wallet}</dt>
          <dd className="num">{fmt(state?.walletAmount ?? null, t.decimals)}</dd>
        </div>
      </dl>
      <p className={styles.hint}>{t.hint}</p>
      {state?.loanBlocked && (
        <p className={styles.error}>
          This balance was made private with an older setting that private loans cannot use. Withdraw it to your wallet, then deposit again.
        </p>
      )}
      <div className={styles.depositRow}>
        <AmountInput label="Amount" value={amount} onChange={setAmount} unit={token} decimals={t.decimals} />
        <Button block onClick={() => run("deposit")} loading={busy === "deposit"} disabled={!er || atoms === 0n || atoms > (state?.walletAmount ?? 0n)}>
          Deposit privately
        </Button>
      </div>
      <ul className={styles.fees}>
        <li>
          <span>Network fee</span>
          <span className="num">≈ 0.00001 SOL</span>
        </li>
        {state && state.setupLamports > 0 && (
          <li>
            <span>One-time private account setup</span>
            <span className="num">{(state.setupLamports / 1e9).toFixed(4)} SOL</span>
          </li>
        )}
        <li>
          <span>ZenLo fee</span>
          <span className="num">None</span>
        </li>
      </ul>
      <p className={styles.hint}>
        Deposits and withdrawals are visible on Solana. What happens to the balance in between is not.
      </p>
      <Button variant="secondary" block onClick={() => run("withdraw")} loading={busy === "withdraw"} disabled={!er || !state?.exists}>
        Withdraw everything to my wallet
      </Button>
      <details className={styles.sendBox}>
        <summary>Send privately to another wallet</summary>
        <div className={styles.panelBody}>
          <label className={styles.fieldLabel} htmlFor="send-to">
            Recipient wallet
          </label>
          <input
            id="send-to"
            className={`${styles.input} ${styles.mono}`}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Wallet address"
            aria-invalid={!!to && !toKey}
            autoComplete="off"
            spellCheck={false}
          />
          <AmountInput label="Amount" value={sendAmount} onChange={setSendAmount} unit={token} decimals={t.decimals} />
          <p className={styles.hint}>The recipient needs a private {token} balance already. Only the two of you can see this transfer.</p>
          <Button variant="secondary" onClick={send} loading={busy === "send"} disabled={!er || !toKey || sendAtoms === 0n || (state?.privateAmount ?? 0n) < sendAtoms}>
            Send {sendAmount || "0"} {token} privately
          </Button>
        </div>
      </details>
      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? styles.error : styles.ok}>
          {message.text}
        </p>
      )}
    </div>
  );
}
