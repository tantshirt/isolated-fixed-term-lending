"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { PYTH_PRICE_UPDATE_ACCOUNT } from "@/lib/constants";
import { aiInfo } from "@/lib/private/ai";
import { HYDRA_EPHEMERAL, poolPda } from "@/lib/private/liquidation";
import { PRIVATE_PROGRAM_ID } from "@/lib/private/room-codec";
import { TEE_RPC, TEE_VALIDATOR, attestTee } from "@/lib/private/tee";
import { usePrivate } from "@/lib/private/use-private";
import styles from "./private.module.css";

type Check = { name: string; state: "ok" | "warn" | "fail" | "pending"; detail: string };

const priceAge = (d: Uint8Array) => {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const off = 8 + 32 + (d[40] === 0 ? 2 : 1) + 32;
  return Math.floor(Date.now() / 1000) - Number(v.getBigInt64(off + 20, true));
};

/** Base58 addresses inside a detail render in mono; prose stays in Inter. */
const withMono = (text: string) =>
  text.split(/([1-9A-HJ-NP-Za-km-z]{32,44})/).map((part, i) => (i % 2 ? <span key={i} className={styles.mono}>{part}</span> : part));

/** Live health of everything the private protocol depends on. Read-only. */
export function DiagnosticsPage() {
  const { base, er, status, connect } = usePrivate();
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    const out: Check[] = [];
    const push = (c: Check) => (out.push(c), setChecks([...out]));
    const attempt = async (name: string, f: () => Promise<Omit<Check, "name">>) => {
      try {
        push({ name, ...(await f()) });
      } catch (e) {
        push({ name, state: "fail", detail: e instanceof Error ? e.message.slice(0, 160) : "Unavailable" });
      }
    };
    await attempt("TEE attestation", async () => {
      await attestTee();
      return { state: "ok", detail: "Intel TDX quote verified for devnet-tee.magicblock.app." };
    });
    await attempt("Validator identity", async () => {
      const r = await fetch(TEE_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity" }) });
      const id = (await r.json())?.result?.identity as string | undefined;
      if (!id) return { state: "warn", detail: "The TEE did not report an identity to an unauthenticated caller." };
      return id === TEE_VALIDATOR.toBase58() ? { state: "ok", detail: `${id} matches the pinned validator.` } : { state: "fail", detail: `${id} is not the pinned ${TEE_VALIDATOR.toBase58()}.` };
    });
    await attempt("Private program", async () => {
      const info = await base.getAccountInfo(PRIVATE_PROGRAM_ID);
      return info?.executable ? { state: "ok", detail: `${PRIVATE_PROGRAM_ID.toBase58()} is deployed on Devnet.` } : { state: "fail", detail: "Not deployed." };
    });
    await attempt("SOL/USD price (Solana)", async () => {
      const info = await base.getAccountInfo(PYTH_PRICE_UPDATE_ACCOUNT);
      if (!info) return { state: "fail", detail: "Price account missing." };
      const age = priceAge(info.data);
      return { state: age <= 60 ? "ok" : "warn", detail: `${age}s old. Acceptance and liquidation need under 60s; Devnet refreshes every few minutes.` };
    });
    if (er) {
      await attempt("SOL/USD price (private rollup)", async () => {
        const info = await er.getAccountInfo(PYTH_PRICE_UPDATE_ACCOUNT);
        if (!info) return { state: "fail", detail: "The rollup has no copy of the price account." };
        const age = priceAge(info.data);
        return { state: age <= 60 ? "ok" : "warn", detail: `${age}s old, owner ${info.owner.toBase58().slice(0, 6)}… (canonical Pyth receiver).` };
      });
      await attempt("Automatic checks (Hydra)", async () => {
        const cranks = await er.getProgramAccounts(HYDRA_EPHEMERAL);
        const ours = cranks.filter((c) => c.account.data.subarray(120).includes(PRIVATE_PROGRAM_ID.toBuffer()));
        return { state: "ok", detail: `${ours.length} Lendspan schedules in the rollup; a Vercel Cron job triggers due ones every minute.` };
      });
    }
    await attempt("Liquidation pool", async () => {
      const info = await base.getAccountInfo(poolPda());
      return info ? { state: "ok", detail: `${poolPda().toBase58()} exists.` } : { state: "warn", detail: "Not created yet; liquidation quotes cannot be funded." };
    });
    await attempt("AI copilot", async () => {
      const i = await aiInfo();
      return i.configured ? { state: "ok", detail: `${i.model} through ${i.provider}, with a budget-capped key.` } : { state: "warn", detail: "Turned off on this deployment." };
    });
    setRunning(false);
  }, [base, er]);

  useEffect(() => void run(), [run]);

  return (
    <div className="page page-narrow">
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link href="/devnet/private">Private</Link>
        <span aria-hidden>/</span>
        <span>Diagnostics</span>
      </nav>
      <header className={styles.hero}>
        <h1 className={styles.title}>Is everything working?</h1>
        <p className={styles.lede}>Live checks of the rollup, the program, prices, automation, and the copilot. Nothing here signs or spends.</p>
      </header>
      <section className={styles.panel} aria-live="polite">
        {checks.length > 0 && (
          <p className={styles.checkSummary}>
            {checks.filter((c) => c.state === "ok").length} of {checks.length} checks OK{running ? ", still checking" : ""}
          </p>
        )}
        <ul className={styles.checks}>
          {checks.map((c) => (
            <li key={c.name} className={styles.check} data-state={c.state}>
              <span className={styles.checkDot} aria-hidden />
              <span className={styles.checkName}>{c.name}</span>
              <span className={styles.badge}>{c.state === "ok" ? "OK" : c.state === "warn" ? "Needs attention" : c.state === "fail" ? "Failing" : "Checking"}</span>
              <span className={styles.checkDetail}>{withMono(c.detail)}</span>
            </li>
          ))}
        </ul>
        <div className={styles.panelBody}>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={run} loading={running}>
              Run again
            </Button>
            {status !== "ready" && (
              <Button variant="ghost" onClick={connect}>
                Sign in to check the rollup&apos;s copies too
              </Button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
