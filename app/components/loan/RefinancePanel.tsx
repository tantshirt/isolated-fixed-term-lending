"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Chips } from "@/components/ui/Chips";
import type { Balances } from "@/lib/client/hooks";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { formatBpsAsPercent, formatDeadline, formatDuration, formatUsdc, formatWsol } from "@/lib/format";
import { annualizedBps, EarlyRepayment, graceEnd, maturity, terminalClaimFrom } from "@/lib/loan-math-v2";
import type { ViewAction } from "@/lib/models/loan-view";
import { useOffersV2 } from "@/lib/v2/hooks";
import type { OfferV2 } from "@/lib/v2/offers";
import { REFINANCE_SIGNING_ALLOWANCE, refinanceCandidates } from "@/lib/v2/refinance";
import * as v2 from "@/lib/v2/transactions";
import styles from "@/components/offer/ActionPanel.module.css";

type Props = {
  offer: OfferV2;
  action: ViewAction | undefined;
  signer: LoanSigner;
  now: number;
  balances: Balances | null;
  busy: boolean;
  run: (fn: () => Promise<string>, moved: string) => Promise<void>;
  panel: (title: string, body: string, children?: React.ReactNode, note?: string | null) => React.ReactNode;
};

/**
 * Story 26.1: the borrower picks an open offer and sees exactly what moves before signing. Nothing
 * refinances without this signature; there is no automatic rollover.
 */
export function RefinancePanel({ offer, action, signer, now, balances, busy, run, panel }: Props) {
  const enabled = !!action?.available;
  const rows = useOffersV2(enabled);
  const [pick, setPick] = useState<string | null>(null);
  if (!action) return null;
  if (!enabled) return panel("Refinance", "Move this loan into a new offer in one step.", null, action.reason ?? null);

  const me = signer.publicKey.toBase58();
  // Quote at the end of the signing allowance, so the bound covers interest accrued meanwhile.
  const at = now + REFINANCE_SIGNING_ALLOWANCE;
  const candidates = rows ? refinanceCandidates(offer, rows, me, at).slice(0, 3) : [];
  const chosen = candidates.find((c) => c.offer.publicKey === pick) ?? candidates[0] ?? null;
  if (!rows) return panel("Refinance", "Looking for open offers that can take this loan.");
  if (!chosen)
    return panel(
      "Refinance",
      "No open offer can take this loan right now. An offer must lend no more than you owe, in the same assets, and be open to you. Ask your lender for a renewal offer reserved to you.",
    );

  const { offer: next, quote } = chosen;
  const t = next.terms;
  const startsAt = { ...t, startTs: now };
  const shortUsdc = balances ? balances.usdc < quote.contribution : false;
  const shortWsol = balances && quote.collateralBack < 0n ? balances.wsol < -quote.collateralBack : false;
  const label = (o: OfferV2) => `${formatUsdc(o.terms.principal)} USDC · ${formatBpsAsPercent(o.terms.interestBps, 2)} / ${formatDuration(o.terms.duration)}`;

  return panel(
    "Refinance",
    "Pay off this loan with a new one, in one transaction. Your old lender is paid in full and your collateral moves straight to the new loan.",
    <>
      {candidates.length > 1 && <Chips label="New offer" options={candidates.map((c) => ({ value: c.offer.publicKey, label: label(c.offer) }))} value={next.publicKey} onChange={setPick} />}
      <dl className={styles.sheet}>
        <div>
          <dt>Paid to your old lender</dt>
          <dd className="num">{formatUsdc(quote.payoffOld)} USDC</dd>
        </div>
        <div>
          <dt>From the new lender</dt>
          <dd className="num">{formatUsdc(quote.newPrincipal)} USDC</dd>
        </div>
        <div>
          <dt>From you</dt>
          <dd className="num">{formatUsdc(quote.contribution)} USDC</dd>
        </div>
        <div>
          <dt>Collateral in the new loan</dt>
          <dd className="num">{formatWsol(quote.newCollateral)} wSOL</dd>
        </div>
        {quote.collateralBack !== 0n && (
          <div>
            <dt>{quote.collateralBack > 0n ? "Collateral back to you" : "Collateral you add"}</dt>
            <dd className="num">{formatWsol(quote.collateralBack > 0n ? quote.collateralBack : -quote.collateralBack)} wSOL</dd>
          </div>
        )}
      </dl>
      <ul className={styles.review}>
        <li>
          New terms: {formatBpsAsPercent(t.interestBps, 2)} for {formatDuration(t.duration)}, about {formatBpsAsPercent(annualizedBps(t), 1)} a year on a 365-day year;{" "}
          {t.earlyRepayment === EarlyRepayment.ProRata ? "interest for time used if repaid early." : "full-term interest whenever repaid."}
        </li>
        <li>
          New deadline {formatDeadline(maturity(startsAt))}, grace until {formatDeadline(graceEnd(startsAt))}. A one-time late fee of {formatBpsAsPercent(t.lateFeeBps, 2)} applies after
          the deadline.
        </li>
        <li>
          <strong>From {formatDeadline(terminalClaimFrom(startsAt))} the new lender may take all of your collateral, even if it is worth more than you owe.</strong>
        </li>
        <li>Your old loan ends as refinanced, not repaid. No cash is paid out to you.</li>
      </ul>
      <Button
        size="lg"
        block
        loading={busy}
        disabled={shortUsdc || !!shortWsol}
        onClick={() => run(() => v2.sendRefinanceV2(signer, offer, next, quote.contribution), `Refinanced into a ${formatUsdc(quote.newPrincipal)} USDC loan`)}
      >
        {quote.contribution > 0n ? `Pay ${formatUsdc(quote.contribution)} USDC and refinance` : "Refinance"}
      </Button>
    </>,
    shortUsdc ? `You hold ${formatUsdc(balances!.usdc)} USDC.` : shortWsol ? `You hold ${formatWsol(balances!.wsol)} wSOL.` : `Quoted for the next ${REFINANCE_SIGNING_ALLOWANCE / 60} minutes; you never pay more than shown.`,
  );
}
