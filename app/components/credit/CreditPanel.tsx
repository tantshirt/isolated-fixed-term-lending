"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ProviderLogo } from "@/components/brand/ProviderLogo";
import { Button } from "@/components/ui/Button";
import { capabilityFor, WSOL } from "@/lib/capabilities";
import { useChainNow } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { TIER_CAPS, tierLabel } from "@/lib/credit/bands";
import { fetchMyCredit } from "@/lib/credit/chain";
import { CREDIT_PILOT_ENABLED } from "@/lib/credit/flag";
import type { CreditStatus } from "@/lib/credit/sas";
import type { IssuanceRequest } from "@/lib/credit/verify-income";
import { issuanceHandoff } from "@/lib/credit/issuance-handoff";
import { AsyncScope } from "@/lib/async-scope";
import { formatBpsAsPercent, formatDeadline, shortKey } from "@/lib/format";
import { getConnection } from "@/lib/program";
import { HistoryPanel } from "./HistoryPanel";
import styles from "./Credit.module.css";

type Step =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; url: string }
  | { kind: "checking" }
  | { kind: "eligible"; issuance: IssuanceRequest }
  | { kind: "ineligible" }
  | { kind: "error"; message: string };

/**
 * Story 26.7: the borrower's credit credential. Shows the on-chain SAS credential for the connected
 * wallet (tier and expiry only) and the "get verified" flow: a Reclaim income proof goes straight
 * from Reclaim's callback to ZenLo's server, which verifies and discards it. This page never stores
 * the proof or an income figure, in the browser or anywhere else.
 */
export function CreditPanel() {
  const { publicKey } = useSigner();
  return <WalletCreditPanel key={publicKey?.toBase58() ?? "disconnected"} />;
}

function WalletCreditPanel() {
  const { publicKey, setConnectOpen } = useSigner();
  const now = useChainNow();
  const sas = capabilityFor("sas", "devnet", WSOL, "credential");
  const reclaim = capabilityFor("reclaim", "devnet", "*", "credential");
  const [status, setStatus] = useState<CreditStatus | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const wallet = publicKey?.toBase58() ?? null;
  const scope = useRef(new AsyncScope());
  useEffect(() => {
    const current = scope.current;
    return () => current.invalidate();
  }, []);

  useEffect(() => {
    if (!publicKey || now === null || !sas.available) return;
    let live = true;
    fetchMyCredit(getConnection(), publicKey, now)
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ state: "none", reason: "Could not read your credential from Devnet. Try again." }));
    return () => {
      live = false;
    };
    // `now` ticks; re-reading on every tick is unnecessary, the expiry check below uses it live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, sas.available, refresh, now === null]);

  async function getVerified() {
    if (!wallet) return;
    const operation = scope.current.capture();
    setStep({ kind: "starting" });
    try {
      const res = await fetch("/api/credit/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) });
      const body = (await res.json()) as { request?: string; error?: string };
      operation.assertActive();
      if (!res.ok || !body.request) throw new Error(body.error ?? "Reclaim could not start a session.");
      const { ReclaimProofRequest } = await import("@reclaimprotocol/js-sdk");
      operation.assertActive();
      const req = await ReclaimProofRequest.fromJsonString(body.request);
      const url = await req.getRequestUrl();
      operation.assertActive();
      setStep({ kind: "waiting", url });
      await req.startSession({
        // The proof is forwarded once, as is, and never kept in state or storage here.
        onSuccess: (proof) => {
          if (!operation.active()) return;
          setStep({ kind: "checking" });
          void submitProof(wallet, Array.isArray(proof) ? proof[0] : proof, operation);
        },
        onError: () => { if (operation.active()) setStep({ kind: "error", message: "Reclaim did not finish the proof. You can start again." }); },
      });
    } catch (e) {
      if (!operation.active()) return;
      setStep({ kind: "error", message: e instanceof Error ? e.message : "Could not start verification." });
    }
  }

  async function submitProof(subject: string, proof: unknown, operation: ReturnType<AsyncScope["capture"]>) {
    try {
      const res = await fetch("/api/credit/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: subject, proof }) });
      const body = (await res.json()) as { eligible?: boolean; issuance?: IssuanceRequest; error?: string };
      operation.assertActive();
      if (!res.ok) throw new Error(body.error ?? "The proof could not be verified.");
      if (body.eligible && body.issuance) setStep({ kind: "eligible", issuance: body.issuance });
      else setStep({ kind: "ineligible" });
    } catch (e) {
      if (!operation.active()) return;
      setStep({ kind: "error", message: e instanceof Error ? e.message : "The proof could not be verified." });
    }
  }

  if (!CREDIT_PILOT_ENABLED)
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Credit</h1>
        <p className={styles.lede}>The credit pilot is invite-only and not enabled on this deployment.</p>
      </div>
    );

  const live = status && status.state === "valid" && now !== null && now >= status.expiry ? ({ state: "expired", tier: status.tier, expiry: status.expiry } as const) : status;

  return (
    <div className={styles.page}>
      <Link href="/devnet/me">← My loans</Link>
      <header>
        <h1 className={styles.title}>Credit</h1>
        <p className={styles.lede}>
          An invited pilot for wSOL loans. A verified credential lets an invited offer lend at a higher max LTV. The tier is fixed on a loan when it starts;
          a credential that expires later does not change that loan.
        </p>
      </header>

      <section className={styles.panel} aria-labelledby="cred-h">
        <h2 id="cred-h">Your credential</h2>
        <p className={styles.provenance}>
          <ProviderLogo id="sas" height={18} /> <span>Solana Attestation Service</span>
        </p>
        {!sas.available ? (
          <p className={styles.warn}>{sas.reason}</p>
        ) : !wallet ? (
          <div className={styles.row}>
            <Button onClick={() => setConnectOpen(true)}>Connect a wallet</Button>
          </div>
        ) : !live ? (
          <p className={styles.note} role="status">Reading your credential from Devnet…</p>
        ) : (
          <dl className={styles.facts}>
            <div>
              <dt>Status</dt>
              <dd>{live.state === "valid" ? "Verified" : live.state === "expired" ? "Expired" : live.state === "invalid" ? "Not usable" : "Not verified"}</dd>
            </div>
            <div>
              <dt>Tier</dt>
              <dd className="num">{live.state === "valid" ? tierLabel(live.tier) : "Standard caps"}</dd>
            </div>
            {(live.state === "valid" || live.state === "expired") && (
              <div>
                <dt>{live.state === "valid" ? "Expires" : "Expired"}</dt>
                <dd className="num">{live.expiry > 0 ? formatDeadline(live.expiry) : "No expiry set"}</dd>
              </div>
            )}
            {live.state === "valid" && (
              <div>
                <dt>Max LTV on invited offers</dt>
                <dd className="num">
                  {formatBpsAsPercent(TIER_CAPS[live.tier].maxLtvBps, 0)} · liquidation {formatBpsAsPercent(TIER_CAPS[live.tier].liquidationLtvBps, 0)}
                </dd>
              </div>
            )}
            {(live.state === "none" || live.state === "invalid") && <p className={styles.note}>{live.reason} Loans use the standard caps (70% max, 85% liquidation).</p>}
          </dl>
        )}
        {wallet && sas.available && (
          <div className={styles.row}>
            <Button variant="ghost" onClick={() => setRefresh((n) => n + 1)}>
              Check again
            </Button>
          </div>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="verify-h">
        <h2 id="verify-h">Get verified</h2>
        <p className={styles.provenance}>
          <ProviderLogo id="reclaim" height={18} /> <span>income proof</span>
        </p>
        <ul className={styles.disclosures}>
          <li>You prove a monthly income range with Reclaim. ZenLo&apos;s server checks the proof and discards it at once; it is never stored, logged or shared.</li>
          <li>Only the resulting tier and its expiry go on chain, in a credential tied to this wallet. Your income figure never does.</li>
          <li>Credentials last 180 days. Higher tiers mean less collateral, and liquidation closer to your max LTV.</li>
        </ul>
        <table className={styles.tiers}>
          <thead>
            <tr>
              <th>Tier</th>
              <th>Max LTV</th>
              <th>Liquidation</th>
            </tr>
          </thead>
          <tbody>
            {([1, 2, 3] as const).map((t) => (
              <tr key={t}>
                <td>{tierLabel(t)}</td>
                <td className="num">{formatBpsAsPercent(TIER_CAPS[t].maxLtvBps, 0)}</td>
                <td className="num">{formatBpsAsPercent(TIER_CAPS[t].liquidationLtvBps, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!reclaim.available ? (
          <p className={styles.warn}>{reclaim.reason}</p>
        ) : !wallet ? (
          <p className={styles.note}>Connect a wallet to start.</p>
        ) : (
          <VerifyStep step={step} onStart={getVerified} wallet={wallet} />
        )}
      </section>

      <HistoryPanel />
    </div>
  );
}

function VerifyStep({ step, onStart, wallet }: { step: Step; onStart: () => void; wallet: string }) {
  switch (step.kind) {
    case "idle":
    case "error":
      return (
        <>
          {step.kind === "error" && <p className={styles.warn} role="alert">{step.message}</p>}
          <div className={styles.row}>
            <Button onClick={onStart}>Prove my income range</Button>
          </div>
        </>
      );
    case "starting":
      return <p className={styles.note} role="status">Starting a Reclaim session…</p>;
    case "waiting":
      return (
        <p className={styles.note} role="status">
          Finish the proof in Reclaim:{" "}
          <a className={styles.link} href={step.url} target="_blank" rel="noreferrer">
            open Reclaim
          </a>
          . This page continues by itself.
        </p>
      );
    case "checking":
      return <p className={styles.note} role="status">Checking the proof. It is discarded as soon as it is checked.</p>;
    case "ineligible":
      return <p className={styles.note}>The proven income is below the pilot&apos;s lowest band. Your loans keep the standard caps.</p>;
    case "eligible":
      return (
        <>
          <p className={styles.good}>
            Eligible for {tierLabel(step.issuance.tier)} until {formatDeadline(step.issuance.expiry)}. Credential issuance is pending for{" "}
            <span className="mono">{shortKey(wallet)}</span>.
          </p>
          <p className={styles.note}>Download the signed request and give it to the pilot issuer. This deployment does not submit it automatically. Standard caps apply until the issuer publishes the credential and it appears above.</p>
          <Button variant="secondary" onClick={() => {
            const url = URL.createObjectURL(new Blob([issuanceHandoff(step.issuance)], { type: "application/json" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `zenlo-credit-request-${wallet.slice(0, 8)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}>Download signed issuance request</Button>
          <p className={styles.note}>Only public credential fields and the issuer signature are included; no proof or income figure.</p>
        </>
      );
  }
}
