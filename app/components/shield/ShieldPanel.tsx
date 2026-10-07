"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import { ProviderLogo } from "@/components/brand/ProviderLogo";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { capabilityFor, DEVNET_USDC, WSOL } from "@/lib/capabilities";
import { useSigner } from "@/lib/client/signer-context";
import { NETWORK, RPC_URL, WS_URL } from "@/lib/constants";
import { formatWsol, shortKey } from "@/lib/format";
import {
  UMBRA_DEVNET_INDEXER,
  balanceWords,
  callbackWords,
  parseWsolAmount,
  shieldErrorMessage,
  subscriptionsUrl,
  type EncryptedBalanceState,
} from "@/lib/umbra/shield";
import type { UmbraSession } from "@/lib/umbra/session";
import { AsyncScope } from "@/lib/async-scope";
import styles from "./Shield.module.css";

/**
 * Wallet-side Umbra shielding for wSOL (Story 26.6): a step before a deposit or after a withdrawal.
 * ZenLo's loans, mints and programs are unchanged. The Umbra SDK loads only when the person acts.
 */
export function ShieldPanel({ wsolBalance }: { wsolBalance: bigint | null }) {
  const { publicKey, source } = useSigner();
  const capability = capabilityFor("umbra", "devnet", WSOL, "shield");
  const usdc = capabilityFor("umbra", "devnet", DEVNET_USDC, "shield");
  const privacyCash = capabilityFor("privacy-cash", "devnet", WSOL, "shield");
  return (
    <section className={styles.panel} aria-labelledby="shield-h">
      <div className={styles.head}>
        <h2 id="shield-h">Shield wSOL</h2>
        <ProviderLogo id="umbra" height={18} />
      </div>
      <ul className={styles.disclosures}>
        <li>
          <strong>Not fully private.</strong> The amount and time you shield or unshield, and your wallet address, are public on Solana.
          Umbra hides only the balance you hold in between.
        </li>
        <li>This is a wallet step before you deposit or after you withdraw. ZenLo loans still use plain wSOL and USDC; shielded wSOL can&rsquo;t back a loan.</li>
        <li>Your Umbra keys come from one wallet signature and live only in this tab&rsquo;s memory. ZenLo never stores or sends them.</li>
        <li>Devnet only.{!usdc.available && ` USDC can't be shielded here: ${usdc.reason}`}</li>
        {!privacyCash.available && <li>Privacy Cash: {privacyCash.reason}</li>}
      </ul>
      {!capability.available ? (
        <p className={styles.unavailable}>{capability.reason}</p>
      ) : NETWORK !== "devnet" ? (
        <p className={styles.unavailable}>Umbra shielding runs on Devnet only.</p>
      ) : (
        <Live key={`${source}:${publicKey?.toBase58() ?? "disconnected"}`} wsolBalance={wsolBalance} />
      )}
    </section>
  );
}

type Busy = null | "unlock" | "shield" | "unshield" | "recover";

function Live({ wsolBalance }: { wsolBalance: bigint | null }) {
  const { wallet } = useWallet();
  const { publicKey, source } = useSigner();
  const owner = publicKey?.toBase58() ?? null;
  const session = useRef<UmbraSession | null>(null);
  const scope = useRef(new AsyncScope());
  const [shielded, setShielded] = useState<EncryptedBalanceState | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The keyed component owns one wallet. Late responses must not resurrect its keys.
  useEffect(() => {
    const current = scope.current;
    return () => { current.invalidate(); session.current = null; };
  }, []);

  const adapter = wallet?.adapter as { standard?: boolean; wallet?: unknown } | undefined;
  const standardWallet = adapter?.standard ? adapter.wallet : null;

  if (!owner) return <p className={styles.note}>Connect a wallet to shield wSOL.</p>;
  if (source !== "wallet" || !standardWallet)
    return <p className={styles.unavailable}>Shielding needs a Wallet Standard browser wallet that can sign messages, such as Phantom, Backpack or Solflare.</p>;

  const open = async (fresh: boolean, operation: ReturnType<AsyncScope["capture"]>): Promise<UmbraSession> => {
    operation.assertActive();
    if (session.current && !fresh && session.current.owner === owner) return session.current;
    session.current = null;
    const { openUmbraSession } = await import("@/lib/umbra/session");
    operation.assertActive();
    const s = await openUmbraSession({
      wallet: standardWallet,
      owner,
      rpcUrl: RPC_URL,
      rpcSubscriptionsUrl: subscriptionsUrl(RPC_URL, WS_URL),
      indexerApiEndpoint: process.env.NEXT_PUBLIC_UMBRA_INDEXER_URL || UMBRA_DEVNET_INDEXER,
    });
    operation.assertActive();
    session.current = s;
    return s;
  };

  const run = async (kind: Exclude<Busy, null>, action: (operation: ReturnType<AsyncScope["capture"]>) => Promise<string | null>) => {
    const operation = scope.current.capture();
    setBusy(kind);
    setError(null);
    setMessage(null);
    try {
      const result = await action(operation);
      if (operation.active()) setMessage(result);
    } catch (e) {
      if (!operation.active()) return;
      if (process.env.NODE_ENV !== "production") console.warn("Umbra", kind, e instanceof Error ? e.message : e);
      setError(shieldErrorMessage(e));
    } finally {
      if (operation.active()) setBusy(null);
    }
  };

  const refresh = async (s: UmbraSession, operation: ReturnType<AsyncScope["capture"]>) => {
    operation.assertActive();
    const balance = await s.balance();
    operation.assertActive();
    setShielded(balance);
  };

  const view = balanceWords(shielded);
  const shieldCheck = parseWsolAmount(amount, wsolBalance);
  const unshieldCheck = parseWsolAmount(amount, view.lamports);

  return (
    <div className={styles.live}>
      <dl className={styles.balances}>
        <div>
          <dt>In your wallet</dt>
          <dd className="num">{wsolBalance === null ? "…" : `${formatWsol(wsolBalance)} wSOL`}</dd>
        </div>
        <div>
          <dt>Shielded with Umbra</dt>
          <dd className="num">{view.lamports === null ? "Hidden" : `${formatWsol(view.lamports)} wSOL`}</dd>
        </div>
      </dl>
      <p className={styles.note}>{view.note}</p>

      {shielded === null ? (
        <div className={styles.row}>
          <Button
            variant="secondary"
            loading={busy === "unlock"}
            disabled={busy !== null}
            onClick={() =>
              run("unlock", async (operation) => {
                await refresh(await open(false, operation), operation);
                return null;
              })
            }
          >
            Unlock with wallet signature
          </Button>
        </div>
      ) : (
        <>
          <AmountInput
            label="Amount"
            value={amount}
            onChange={setAmount}
            unit="wSOL"
            decimals={9}
            hint="Umbra charges its own protocol fee and needs a little SOL for transaction fees."
          />
          <p className={styles.visible}>Visible on Solana: this amount, the time, and wallet {shortKey(owner)}.</p>
          <div className={styles.row}>
            <Button
              variant="secondary"
              loading={busy === "unshield"}
              disabled={busy !== null || !unshieldCheck.ok}
              title={unshieldCheck.ok ? undefined : unshieldCheck.reason}
              onClick={() =>
                unshieldCheck.ok &&
                run("unshield", async (operation) => {
                  const s = await open(false, operation);
                  const r = await s.unshield(unshieldCheck.lamports);
                  await refresh(s, operation);
                  setAmount("");
                  return callbackWords("unshield", r.status);
                })
              }
            >
              Unshield wSOL
            </Button>
            <Button
              loading={busy === "shield"}
              disabled={busy !== null || !shieldCheck.ok}
              title={shieldCheck.ok ? undefined : shieldCheck.reason}
              onClick={() =>
                shieldCheck.ok &&
                run("shield", async (operation) => {
                  const s = await open(false, operation);
                  const r = await s.shield(shieldCheck.lamports);
                  await refresh(s, operation);
                  setAmount("");
                  return callbackWords("shield", r.status);
                })
              }
            >
              Shield wSOL
            </Button>
          </div>
          {amount && !shieldCheck.ok && !unshieldCheck.ok && <p className={styles.note}>{shieldCheck.reason}</p>}
        </>
      )}

      <div className={styles.recover}>
        <Button
          variant="ghost"
          loading={busy === "recover"}
          disabled={busy !== null}
          onClick={() =>
            run("recover", async (operation) => {
              const s = await open(true, operation);
              await refresh(s, operation);
              return "Keys re-derived from your wallet signature and balance re-read from Devnet.";
            })
          }
        >
          Recover shielded balance
        </Button>
        <p className={styles.note}>Lost this tab or cleared site data? The same wallet signs again and Umbra finds your balance on chain.</p>
      </div>

      <div aria-live="polite">
        {message && <p className={styles.success}>{message}</p>}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
