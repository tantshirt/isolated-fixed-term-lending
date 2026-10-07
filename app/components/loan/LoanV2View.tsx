"use client";

import Link from "next/link";
import { PHASE_WORDS, REFINANCED_WORD } from "@/lib/phase-words";
import { PublicKey } from "@solana/web3.js";
import { useMemo, useState } from "react";
import { Spot } from "@/components/brand/Spot";
import { Skeleton } from "@/components/ui/Skeleton";
import { HealthMeter } from "@/components/offer/HealthMeter";
import { useBalances, useChainNow, useDevConfig, usePrice } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { formatBpsAsPercent, formatDeadline, formatDuration, formatUsdc, formatWsol, shortKey } from "@/lib/format";
import { annualizedBps, chargeCeiling, EarlyRepayment, fullTermInterest, minInterest } from "@/lib/loan-math-v2";
import { v2LoanView, type LoanView } from "@/lib/models/loan-view";
import { useOfferV2 } from "@/lib/v2/hooks";
import { offerV2Pda } from "@/lib/v2/program";
import type { OfferV2 } from "@/lib/v2/offers";
import { priceUsd } from "@/lib/risk";
import { requiredTier, tierLabel } from "@/lib/credit/bands";
import { LoanV2Actions } from "./LoanV2Actions";
import { AlertsPanel } from "./AlertsPanel";
import styles from "@/components/offer/OfferView.module.css";

export type V2Role = "lender" | "borrower" | "viewer";

function keyFor(lender: string, id: string): string | null {
  try {
    return offerV2Pda(new PublicKey(lender), BigInt(id)).toBase58();
  } catch {
    return null;
  }
}

const TITLES: Record<OfferV2["status"], string> = {
  open: "Open offer",
  active: "Waiting for repayment",
  repaid: "Repaid",
  liquidated: "Liquidated",
  overdueLiquidated: "Settled after grace",
  pricedRecovered: "Recovered at the market price",
  terminalClaimed: "Collateral claimed",
  cancelled: "Cancelled",
  refinanced: REFINANCED_WORD,
};

const PHASE_TITLES: Record<NonNullable<LoanView["phase"]>, string> = PHASE_WORDS;

export function LoanV2View({ lender, offerId }: { lender: string; offerId: string }) {
  const key = useMemo(() => keyFor(lender, offerId), [lender, offerId]);
  if (!key) return <Missing title="That loan link is not valid" />;
  return <Loaded offerKey={key} />;
}

function Loaded({ offerKey }: { offerKey: string }) {
  const { offer, error, reload } = useOfferV2(offerKey);
  const { price } = usePrice();
  const now = useChainNow();
  const { publicKey } = useSigner();
  const { config } = useDevConfig();
  const balances = useBalances(publicKey, config);
  const [moved, setMoved] = useState<string | null>(null);

  if (error)
    return (
      <section role="alert" className={styles.missing}>
        <Spot kind="notFound" size={120} />
        <h1 className={styles.title}>Loan unavailable</h1>
        <p className={styles.sentence}>Could not read this loan from the network. Its state is unknown.</p>
        <button type="button" className={styles.back} onClick={reload}>
          Retry
        </button>
      </section>
    );
  if (offer === undefined) return <Skeleton height="320px" />;
  if (offer === null) return <Missing title="This loan is closed" body="The lender closed it after it settled, so it no longer exists on chain." />;

  const me = publicKey?.toBase58() ?? null;
  const role: V2Role = me && me === offer.currentLender ? "lender" : me && me === offer.borrower ? "borrower" : "viewer";
  const view = now === null ? null : v2LoanView(offer, price, now);
  const t = offer.terms;
  const proRata = t.earlyRepayment === EarlyRepayment.ProRata;
  const title = offer.status === "active" && view?.phase ? PHASE_TITLES[view.phase] : TITLES[offer.status];
  // The next action in one line, above the details, so phones see it first.
  const next = (() => {
    if (!view) return null;
    if (offer.status === "open") return role === "lender" ? "Waiting for a borrower. You can cancel any time." : `Lock ${formatWsol(offer.collateralRequired)} wSOL to borrow ${formatUsdc(t.principal)} USDC.`;
    if (offer.status !== "active") return null;
    const due = view.deadlines.find((d) => d.kind === (view.phase === "Active" ? "maturity" : "grace-end"));
    if (role === "borrower")
      return view.phase === "Active" || view.phase === "Grace"
        ? `Repay ${formatUsdc(view.payoff)} USDC${due ? ` by ${formatDeadline(due.at)}` : ""} to get all your wSOL back.`
        : `Repay ${formatUsdc(view.payoff)} USDC now to keep your wSOL; a settlement can happen at any time.`;
    if (role === "lender") return view.actions.some((a) => a.by === "lender" && a.available) ? "A recovery step is open to you below." : "Payments come straight to your wallet.";
    return view.actions.some((a) => a.by === "anyone" && a.available) ? "Anyone may settle this loan now." : publicKey ? null : "Connect a wallet to act on this loan.";
  })();

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <Link href="/devnet/me" className={styles.back}>
          ← My loans
        </Link>
        <header className={styles.head}>
          <div className={styles.pills}>
            <span className={styles.role}>{role === "lender" ? "You lend" : role === "borrower" ? "You borrow" : "Repayment-rules loan"}</span>
          </div>
          <h1 className={styles.title}>{title}</h1>
          {next && <p className={styles.sentence}>{next}</p>}
          {moved && <p className={styles.moved}>{moved}</p>}
        </header>

        <div className={styles.figures}>
          <Figure label={offer.status === "active" ? "To close it now" : "Principal"} value={`${formatUsdc(view && offer.status === "active" ? view.payoff : t.principal)} USDC`} />
          <Figure label="Principal still owed" value={`${formatUsdc(offer.status === "active" ? offer.ledger.outstandingPrincipal : offer.status === "open" ? t.principal : 0n)} USDC`} />
          <Figure label="Collateral locked" value={`${formatWsol(offer.status === "open" ? offer.collateralRequired : offer.collateralLocked)} wSOL`} />
        </div>

        {view?.risk && (
          <HealthMeter
            ltvBps={view.risk.ltvBps}
            healthBps={view.risk.healthBps}
            maxLtvBps={offer.maxLtvBps}
            liquidationLtvBps={offer.liquidationLtvBps}
            stale={!view.risk.priced}
            liquidationPrice={null}
            solPrice={price ? priceUsd(price) : null}
          />
        )}

        <section className={styles.block} aria-labelledby="rules-title">
          <h2 id="rules-title" className={styles.blockTitle}>
            Repayment rules
          </h2>
          <dl className={styles.terms}>
            <Row label="Term cost" value={`${formatUsdc(fullTermInterest(t))} USDC (${formatBpsAsPercent(t.interestBps, 2)} for ${formatDuration(t.duration)})`} />
            <Row label="Annualized pricing" value={`${formatBpsAsPercent(annualizedBps(t), 1)} on a 365-day year`} />
            <Row label="Early repayment" value={proRata ? `Interest for time used, at least ${formatUsdc(minInterest(t))} USDC` : "Full-term interest whenever repaid"} />
            <Row label="Annual pricing ceiling" value={`${formatBpsAsPercent(t.annualCeilingBps, 0)}: charges never exceed ${formatUsdc(chargeCeiling(t))} USDC`} />
            {creditRow(offer) && <Row label="Credit tier" value={creditRow(offer)!} />}
            <Row label="Grace" value={formatDuration(t.graceSeconds)} />
            <Row label="Late fee" value={`${formatBpsAsPercent(t.lateFeeBps, 2)} of principal unpaid at the deadline, once`} />
            {offer.status === "active" && (
              <>
                <Row label="Interest paid so far" value={`${formatUsdc(offer.ledger.interestPaid)} USDC`} />
                {offer.ledger.lateFeeAssessed > 0n && <Row label="Late fee charged" value={`${formatUsdc(offer.ledger.lateFeeAssessed)} USDC`} />}
              </>
            )}
            {offer.shortfall > 0n && <Row label="Shortfall recorded" value={`${formatUsdc(offer.shortfall)} USDC the collateral did not cover`} />}
          </dl>
        </section>

        {offer.status !== "open" && view && view.deadlines.length > 0 && (
          <section className={styles.block} aria-labelledby="timeline-title">
            <h2 id="timeline-title" className={styles.blockTitle}>
              What happens when
            </h2>
            <dl className={styles.terms}>
              {view.deadlines.map((d) => (
                <Row
                  key={d.kind}
                  label={{ maturity: "Deadline", "grace-end": "Grace ends", "priced-recovery": "Priced recovery", "terminal-claim": "Final claim" }[d.kind]}
                  value={`${formatDeadline(d.at)}${now !== null && now >= d.at ? " (passed)" : ""}`}
                />
              ))}
            </dl>
            <p className={styles.blockNote}>
              Repayment stays open until a settlement executes. After grace, anyone may pay what is owed and take wSOL worth that plus 5%, returning the rest. From priced
              recovery, the lender may take wSOL worth what is owed and return the rest. From the final claim, the lender may take all of it, even if it is worth more
              than the debt.
            </p>
          </section>
        )}

        {role === "borrower" && offer.currentLender !== offer.originLender && (
          <p className={styles.blockNote}>
            Your lender sold this loan. You now pay <span className="mono">{shortKey(offer.currentLender)}</span>; your terms have not changed.
          </p>
        )}
        <p className={styles.blockNote}>
          Lender <span className="mono">{shortKey(offer.currentLender)}</span>
          {offer.borrower && (
            <>
              {" "}· Borrower <span className="mono">{shortKey(offer.borrower)}</span>
            </>
          )}{" "}
          · Program <span className="mono">isolated_loan_v2</span>
        </p>
      </div>
      <aside className={styles.aside}>
        <LoanV2Actions offer={offer} view={view} role={role} price={price} now={now} balances={balances} onMoved={setMoved} />
        {offer.status === "active" && role !== "viewer" && <AlertsPanel kind="public-v2" loan={offer.publicKey} />}
      </aside>
    </div>
  );
}

/**
 * Story 26.7. A started loan shows the tier fixed at origination; an open invited offer above the
 * standard caps says which credential accepting it needs. Standard loans show nothing.
 */
function creditRow(offer: OfferV2): string | null {
  if (offer.creditTier) return `${tierLabel(offer.creditTier)}, fixed when the loan started; a later expiry does not change it`;
  if (offer.status !== "open") return null;
  const need = requiredTier(offer.maxLtvBps, offer.liquidationLtvBps);
  return need ? `Accepting needs a ${tierLabel(need)} credential or higher (invited borrower only)` : null;
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.figure}>
      <span className={styles.figureLabel}>{label}</span>
      <span className={`${styles.figureValue} num`}>{value}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

function Missing({ title, body }: { title: string; body?: string }) {
  return (
    <section className={styles.missing}>
      <Spot kind="notFound" size={120} />
      <h1 className={styles.title}>{title}</h1>
      {body && <p className={styles.sentence}>{body}</p>}
      <Link href="/devnet/me" className={styles.back}>
        My loans
      </Link>
    </section>
  );
}
