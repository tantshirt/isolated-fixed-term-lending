"use client";

import type { Connection } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { DEVNET_USDC_MINT } from "@/lib/constants";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { depositPrivately, readPrivateBalance, withdrawPrivately, type PrivateBalanceState } from "@/lib/private/balances";
import styles from "./private.module.css";

const fmt = (atoms: bigint | null) =>
  atoms === null ? "—" : (Number(atoms) / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export function BalancePanel({ signer, base, er, onChange }: { signer: LoanSigner | null; base: Connection; er: Connection | null; onChange: () => void }) {
  const [state, setState] = useState<PrivateBalanceState | null>(null);
  const [amount, setAmount] = useState("0.10");
  const [busy, setBusy] = useState<"deposit" | "withdraw" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!signer) return setState(null);
    try {
      setState(await readPrivateBalance(base, er, signer.publicKey, DEVNET_USDC_MINT));
    } catch {
      setState(null);
    }
  }, [signer, base, er]);
  useEffect(() => void refresh(), [refresh]);

  const atoms = (() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1_000_000)) : 0n;
  })();

  async function run(kind: "deposit" | "withdraw") {
    if (!signer || !er) return;
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === "deposit") await depositPrivately(base, er, signer, DEVNET_USDC_MINT, atoms);
      else await withdrawPrivately(base, er, signer, DEVNET_USDC_MINT);
      setMessage({ tone: "ok", text: kind === "deposit" ? "Deposited. Your balance is now private." : "Withdrawn to your wallet." });
      onChange();
      await refresh();
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.panelBody}>
      <dl className={styles.balances}>
        <div>
          <dt>Private USDC</dt>
          <dd className="num">{er ? fmt(state?.privateAmount ?? (state?.exists ? 0n : null)) : <span className={styles.pending}>Private until you sign in</span>}</dd>
        </div>
        <div>
          <dt>In your wallet</dt>
          <dd className="num">{fmt(state?.walletAmount ?? null)}</dd>
        </div>
      </dl>
      <div className={styles.depositRow}>
        <AmountInput label="Amount" value={amount} onChange={setAmount} unit="USDC" decimals={6} />
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
          <span>Lendspan fee</span>
          <span className="num">None</span>
        </li>
      </ul>
      <p className={styles.hint}>
        Deposits and withdrawals are visible on Solana. What happens to the balance in between is not.
      </p>
      <Button variant="secondary" block onClick={() => run("withdraw")} loading={busy === "withdraw"} disabled={!er || !state?.exists}>
        Withdraw everything to my wallet
      </Button>
      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? styles.error : styles.ok}>
          {message.text}
        </p>
      )}
    </div>
  );
}
