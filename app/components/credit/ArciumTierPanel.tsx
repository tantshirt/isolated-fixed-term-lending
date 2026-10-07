"use client";

import { useEffect, useState } from "react";
import { ProviderLogo } from "@/components/brand/ProviderLogo";
import { Button } from "@/components/ui/Button";
import { capabilityFor, WSOL } from "@/lib/capabilities";
import { useChainNow } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { fetchArciumTier, type ArciumTierStatus } from "@/lib/credit/arcium";
import { TIER_CAPS, tierLabel } from "@/lib/credit/bands";
import { formatBpsAsPercent, formatDeadline } from "@/lib/format";
import { getConnection } from "@/lib/program";
import styles from "./Credit.module.css";

/**
 * Story 27.1: "Private tier via Arcium". Shows the connected wallet's TierResult from
 * zenlo_credit_mxe. The tier is computed by Arcium from the history attestation the borrower
 * published (rollup-signed counts, never typed in) and the band of their SAS credential; only the
 * tier comes back. Read-only: a request is a `request_tier` transaction signed by the borrower.
 */
export function ArciumTierPanel() {
  const { publicKey } = useSigner();
  const now = useChainNow();
  const cap = capabilityFor("arcium", "devnet", WSOL, "credential");
  const [status, setStatus] = useState<ArciumTierStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const wallet = publicKey?.toBase58() ?? null;

  useEffect(() => {
    if (!publicKey || now === null || !cap.available) return;
    let live = true;
    setFailed(false);
    fetchArciumTier(getConnection(), publicKey, now)
      .then((s) => live && setStatus(s))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, cap.available, refresh, now === null]);

  return (
    <section className={styles.panel} aria-labelledby="arcium-h">
      <h2 id="arcium-h">Private tier via Arcium</h2>
      <p className={styles.provenance}>
        <ProviderLogo id="arcium" height={14} /> <span>Arcium encrypted computation</span>
      </p>
      <ul className={styles.disclosures}>
        <li>Arcium computes a tier from the repayment counts you attested from your private history, and the income band of your credential. You cannot type the counts in.</li>
        <li>Only the tier is published. The counts in your attestation are already public by your choice; your loans, lenders and income figure never leave where they are.</li>
        <li>A tier computed this way can stand in for your credential on an invited wSOL offer. It stops counting 30 days after the attestation it used, or when your credential expires.</li>
      </ul>
      {!cap.available ? (
        <p className={styles.warn}>{cap.reason}</p>
      ) : !wallet ? (
        <p className={styles.note}>Connect a wallet to see your private tier.</p>
      ) : failed ? (
        <p className={styles.warn} role="alert">Could not read your private tier from Devnet. Try again.</p>
      ) : !status ? (
        <p className={styles.note} role="status">Reading your private tier from Devnet…</p>
      ) : status.state === "none" ? (
        <p className={styles.note}>No private tier yet. Attest your history above, then request a tier.</p>
      ) : status.state === "pending" ? (
        <p className={styles.note} role="status">Arcium is computing your tier. It appears here when the result is written.</p>
      ) : status.state === "unusable" ? (
        <p className={styles.note}>Your last private tier does not count now: {status.reason}</p>
      ) : (
        <dl className={styles.facts}>
          <div>
            <dt>Tier</dt>
            <dd className="num">{tierLabel(status.tier)}</dd>
          </div>
          <div>
            <dt>Counts until</dt>
            <dd className="num">{formatDeadline(status.validUntil)}</dd>
          </div>
          <div>
            <dt>Max LTV on invited offers</dt>
            <dd className="num">
              {formatBpsAsPercent(TIER_CAPS[status.tier].maxLtvBps, 0)} · liquidation {formatBpsAsPercent(TIER_CAPS[status.tier].liquidationLtvBps, 0)}
            </dd>
          </div>
        </dl>
      )}
      {wallet && cap.available && (
        <div className={styles.row}>
          <Button variant="ghost" onClick={() => setRefresh((n) => n + 1)}>
            Check again
          </Button>
        </div>
      )}
    </section>
  );
}
