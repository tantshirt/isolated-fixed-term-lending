"use client";

import { AnimatePresence, m } from "motion/react";
import { useState, type ReactNode } from "react";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { Chips } from "@/components/ui/Chips";
import { messageFromAnchorError } from "@/lib/anchor-errors";
import type { Balances, LivePrice } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { formatBpsAsPercent, formatDeadline, formatDuration, formatUsdc, formatWsol } from "@/lib/format";
import { applyPayment, EarlyRepayment, liquidationSplit, maturity, maxExposure, payoff, pricedRecoverySplit } from "@/lib/loan-math-v2";
import type { LoanView } from "@/lib/models/loan-view";
import { parseAmount } from "@/lib/offer-validation";
import { sendPythUpdate } from "@/lib/pyth";
import { currentLtvBps } from "@/lib/loan-math";
import { SubmissionError, signatureUrl } from "@/lib/transaction-lifecycle";
import type { OfferV2 } from "@/lib/v2/offers";
import { reviewFigures } from "@/lib/v2/rules";
import * as v2 from "@/lib/v2/transactions";
import { collateralForMint, collateralValueAtoms, hasOwnFeed } from "@/lib/models/collateral";
import type { V2Role } from "./LoanV2View";
import { RefinancePanel } from "./RefinancePanel";
import { MandatePanel } from "./MandatePanel";
import { MANDATES_ENABLED } from "@/lib/v2/mandates";
import styles from "@/components/offer/ActionPanel.module.css";

/** Seconds of accrual a signature allows for while it is reviewed and confirmed. */
const SIGNING_ALLOWANCE = 120;

type Props = {
  offer: OfferV2;
  view: LoanView | null;
  role: V2Role;
  price: LivePrice | null;
  now: number | null;
  balances: Balances | null;
  onMoved: (line: string) => void;
};

export function LoanV2Actions({ offer, view, role, price, now, balances, onMoved }: Props) {
  const { signer, setConnectOpen, bumpRefresh } = useSigner();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [partial, setPartial] = useState("");
  const [topUp, setTopUp] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  const can = (a: string) => view?.actions.find((x) => x.action === a);
  // Story 26.2: labels, decimals and feed follow the loan's collateral. An asset with its own feed
  // (jitoSOL (test)) posts a fresh update inside the signed sequence, so it never needs a separate
  // "post a price" step; `price` is that feed's latest Hermes reading.
  const asset = collateralForMint(offer.wsolMint);
  const unit = asset.label;
  const ownFeed = hasOwnFeed(asset);
  const run = async (fn: () => Promise<string>, moved: string) => {
    setError(null);
    setBusy(true);
    try {
      const signature = await fn();
      setReceipt(signature);
      setConfirming(null);
      onMoved(moved);
      toast({ tone: "success", title: moved });
      bumpRefresh();
    } catch (e) {
      setError(e instanceof SubmissionError ? e.message : messageFromAnchorError(e));
      if (e instanceof SubmissionError && e.signature) setReceipt(e.signature);
    } finally {
      setBusy(false);
    }
  };
  const postPrice = signer && !ownFeed ? () => run(async () => (await sendPythUpdate(signer)).signatures.at(-1) ?? "", "A fresh SOL price is on chain") : undefined;
  const stale = ownFeed ? !price : !price?.fresh;
  const panel = (title: string, body: string, children?: ReactNode, note?: string | null, tone?: "risk") => (
    <Panel title={title} body={body} error={error} receipt={receipt} busy={busy} note={note} tone={tone}>
      {children}
    </Panel>
  );

  // A settled loan needs nothing from a visitor; only its lender can close it for rent. Its
  // borrower may still revoke a leftover mandate to reclaim the rent (Story 26.3).
  if (offer.status !== "open" && offer.status !== "active" && role !== "lender") {
    if (role === "borrower" && signer && now !== null && MANDATES_ENABLED)
      return (
        <>
          {panel("Settled", "Nothing is left to do on this loan.")}
          <MandatePanel offer={offer} action={{ action: "mandate", by: "borrower", available: true }} signer={signer} now={now} busy={busy} run={run} panel={panel} />
        </>
      );
    return panel("Settled", "Nothing is left to do on this loan.");
  }

  if (!signer) {
    return panel(
      "Connect to continue",
      "Connect the wallet that should sign this step.",
      <Button size="lg" block onClick={() => setConnectOpen(true)}>
        Connect wallet
      </Button>,
    );
  }
  if (now === null) return panel("Waiting for the chain clock", "Actions appear once the network time is known, so no deadline is guessed.");

  // ---- Open offer ----
  if (offer.status === "open") {
    if (role === "lender")
      return panel(
        "Waiting for a borrower",
        "Your USDC sits in the offer's vault. Cancel at any time before someone accepts.",
        <Button variant="secondary" size="lg" block loading={busy} onClick={() => run(() => v2.sendCancelOfferV2(signer, offer), `You received ${formatUsdc(offer.terms.principal)} USDC back`)}>
          Cancel offer
        </Button>,
      );
    const f = reviewFigures(offer.terms, now);
    const exposure = maxExposure(offer.terms);
    const fits = price ? currentLtvBps(exposure, collateralValueAtoms(offer.collateralRequired, asset.decimals, price.price, price.conf, price.exponent)) <= offer.maxLtvBps : false;
    const restricted = offer.restrictedBorrower && offer.restrictedBorrower !== signer.publicKey.toBase58();
    const enough = !balances || balances.wsol >= offer.collateralRequired;
    const reason = restricted
      ? "This renewal offer is reserved for another borrower."
      : stale
        ? ownFeed ? `The ${asset.symbol} price is unavailable. Try again shortly.` : "The SOL price is too old to check the collateral. Post a fresh price first."
        : !fits
          ? `At today's ${ownFeed ? asset.symbol : "SOL"} price this collateral does not cover the most this loan can cost, at the offer's max LTV.`
          : !enough
            ? `You hold ${formatWsol(balances!.wsol)} ${unit}. This offer needs ${formatWsol(offer.collateralRequired)}.`
            : null;
    return panel(
      "Review before you borrow",
      `Lock ${formatWsol(offer.collateralRequired)} ${unit} and receive ${formatUsdc(offer.terms.principal)} USDC now.`,
      <>
        <ul className={styles.review}>
          <li>
            {formatBpsAsPercent(offer.terms.interestBps, 2)} for {formatDuration(offer.terms.duration)}: a term cost of {formatUsdc(f.termCost)} USDC, about{" "}
            {formatBpsAsPercent(f.annualizedBps, 1)} a year on a 365-day year.
          </li>
          <li>
            Repaid at the deadline, you owe {formatUsdc(offer.terms.principal + f.termCost)} USDC
            {offer.terms.earlyRepayment === EarlyRepayment.ProRata ? `; repaid earlier, less, but at least ${formatUsdc(offer.terms.principal + f.minInterest)} USDC.` : ", whenever you repay."}
          </li>
          <li>Deadline {formatDeadline(f.maturity)}. A one-time late fee of up to {formatUsdc(f.lateFeeMax)} USDC applies from then.</li>
          <li>Grace ends {formatDeadline(f.graceEnd)}. After that, anyone may pay what you owe and take {unit} worth that plus 5%; the rest comes back to you.</li>
          <li>From {formatDeadline(f.pricedRecoveryFrom)} the lender may take {unit} worth what you owe; the rest comes back to you.</li>
          <li>
            <strong>From {formatDeadline(f.terminalClaimFrom)} the lender may take all of your {unit}, even if it is worth more than you owe.</strong>
          </li>
          <li>Charges never exceed {formatUsdc(f.chargeCeiling)} USDC under the lender&apos;s annual ceiling.</li>
        </ul>
        {stale && postPrice ? (
          <Button variant="secondary" size="lg" block loading={busy} onClick={postPrice}>
            Post a fresh SOL price
          </Button>
        ) : (
          <Button size="lg" block loading={busy} disabled={Boolean(reason)} onClick={() => run(() => v2.sendAcceptOfferV2(signer, offer), `You received ${formatUsdc(offer.terms.principal)} USDC`)}>
            Lock {unit} and borrow
          </Button>
        )}
      </>,
      reason,
    );
  }

  // ---- Settled ----
  if (offer.status !== "active") {
    if (role === "lender")
      return panel(
        "Settled",
        "Close the account to reclaim its rent.",
        <Button variant="secondary" size="lg" block loading={busy} onClick={() => run(() => v2.sendCloseOfferV2(signer, offer), "Rent returned to your wallet")}>
          Close and reclaim rent
        </Button>,
      );
    return panel("Settled", "Nothing is left to do on this loan.");
  }

  // ---- Active: borrower ----
  if (role === "borrower") {
    const owedNow = view?.payoff ?? payoff(offer.terms, offer.ledger, now);
    const amount = mode === "full" ? payoff(offer.terms, offer.ledger, now + SIGNING_ALLOWANCE) : parseAmount(partial, 6);
    const preview = amount && amount > 0n ? applyPayment(offer.terms, offer.ledger, now, amount)[1] : null;
    const short = amount !== null && balances ? balances.usdc < (preview?.used ?? amount) : false;
    const topUpLamports = parseAmount(topUp, asset.decimals);
    return (
      <>
        {panel(
          "Repay",
          `${formatUsdc(owedNow)} USDC closes the loan now and returns all ${formatWsol(offer.collateralLocked)} ${unit}.`,
          <>
            <Chips
              label="How much"
              options={[
                { value: "full", label: "Everything" },
                { value: "partial", label: "Part of it" },
              ]}
              value={mode}
              onChange={setMode}
            />
            {mode === "partial" && <AmountInput label="Amount" value={partial} onChange={setPartial} unit="USDC" decimals={6} />}
            {preview && (
              <p className={styles.body}>
                {preview.closed
                  ? `This closes the loan. Only what is owed when it lands is taken, at most ${formatUsdc(amount!)} USDC.`
                  : `${formatUsdc(preview.interest)} to interest, ${formatUsdc(preview.lateFee)} to the late fee, ${formatUsdc(preview.principal)} to principal. Your deadline stays ${formatDeadline(maturity(offer.terms))}.`}
              </p>
            )}
            <Button
              size="lg"
              block
              loading={busy}
              disabled={!amount || amount <= 0n || short}
              onClick={() => run(() => v2.sendRepayV2(signer, offer, amount!), preview?.closed ? `Repaid. Your ${unit} is back.` : `You paid ${formatUsdc(preview?.used ?? 0n)} USDC`)}
            >
              {mode === "full" ? `Repay and get ${unit} back` : "Pay this amount"}
            </Button>
          </>,
          short ? `You hold ${formatUsdc(balances!.usdc)} USDC.` : view?.phase && view.phase !== "Active" ? `The deadline has passed. Repaying now still returns all of your ${unit}.` : null,
        )}
        {panel(
          "Add collateral",
          `More ${unit} lowers your LTV at once. No price is needed to add it.`,
          <>
            <AmountInput label={`${unit} to add`} value={topUp} onChange={setTopUp} unit={asset.symbol} decimals={asset.decimals} />
            <Button
              variant="secondary"
              size="lg"
              block
              loading={busy}
              disabled={!topUpLamports || topUpLamports <= 0n || (balances ? balances.wsol < topUpLamports : false)}
              onClick={() => run(() => v2.sendAddCollateralV2(signer, offer, topUpLamports!), `You added ${formatWsol(topUpLamports!)} ${unit}`)}
            >
              Add {unit}
            </Button>
          </>,
          topUpLamports && balances && balances.wsol < topUpLamports ? `You hold ${formatWsol(balances.wsol)} ${unit}.${ownFeed ? "" : " Wrap SOL first."}` : null,
        )}
        <RefinancePanel offer={offer} action={can("refinance")} signer={signer} now={now} balances={balances} busy={busy} run={run} panel={panel} />
        <MandatePanel offer={offer} action={can("mandate")} signer={signer} now={now} busy={busy} run={run} panel={panel} />
      </>
    );
  }

  // ---- Active: lender and anyone else ----
  const liquidate = can("liquidate");
  const overdue = can("liquidate-overdue");
  const priced = can("claim-priced");
  const terminal = can("claim-terminal");
  const owed = view?.payoff ?? 0n;
  const value = price ? collateralValueAtoms(offer.collateralLocked, asset.decimals, price.price, price.conf, price.exponent) : null;
  const split = value && value > 0n ? liquidationSplit(owed, offer.collateralLocked, value) : null;
  const recovery = value && value > 0n ? pricedRecoverySplit(owed, offer.collateralLocked, value) : null;
  const stalePriceNeeded = stale && (overdue?.reason?.includes("fresh price") || priced?.reason?.includes("fresh price") || liquidate?.reason?.includes("fresh price"));

  return (
    <>
      {role === "lender" &&
        panel(
          view?.phase === "Active" ? "Waiting for repayment" : "Recovery",
          view?.phase === "Active" ? "You are repaid directly as the borrower pays." : "The deadline has passed. The borrower can still repay until a settlement executes.",
          <>
            {priced?.available && recovery && (
              <Button size="lg" block loading={busy} onClick={() => run(() => v2.sendLenderClaimV2(signer, offer, false), `You received ${formatWsol(recovery.toRecipient)} ${unit}`)}>
                Take {unit} worth {formatUsdc(owed)} USDC
              </Button>
            )}
            {terminal?.available &&
              (confirming === "terminal" ? (
                <div className={styles.confirm}>
                  <p className={styles.confirmQ}>
                    Take all {formatWsol(offer.collateralLocked)} {unit}? Any surplus over the {formatUsdc(owed)} USDC owed goes to you, not the borrower.
                  </p>
                  <div className={styles.row}>
                    <Button variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>
                      Not now
                    </Button>
                    <Button variant="danger" loading={busy} onClick={() => run(() => v2.sendLenderClaimV2(signer, offer, true), `You received ${formatWsol(offer.collateralLocked)} ${unit}`)}>
                      Take all {unit}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="secondary" size="lg" block onClick={() => setConfirming("terminal")}>
                  Final claim: take all {unit}
                </Button>
              ))}
          </>,
          !priced?.available && !terminal?.available ? (priced?.reason ?? null) : !terminal?.available ? (terminal?.reason ?? null) : null,
        )}
      {(liquidate?.available || overdue?.available || stalePriceNeeded) &&
        panel(
          overdue?.available ? "Settle after grace" : "Liquidate",
          split ? `Pay ${formatUsdc(owed)} USDC to the lender and receive ${formatWsol(split.toRecipient)} ${unit}. ${formatWsol(split.toBorrower)} ${unit} returns to the borrower.` : "A fresh price is needed to value the collateral.",
          stale && postPrice ? (
            <Button variant="secondary" size="lg" block loading={busy} onClick={postPrice}>
              Post a fresh SOL price
            </Button>
          ) : (
            <Button
              size="lg"
              block
              variant="danger"
              loading={busy}
              disabled={!split || (balances ? balances.usdc < owed : false)}
              onClick={() => run(() => v2.sendLiquidateV2(signer, offer, Boolean(overdue?.available)), `You received ${formatWsol(split!.toRecipient)} ${unit}`)}
            >
              Pay {formatUsdc(owed)} USDC and settle
            </Button>
          ),
          liquidate?.available && view?.risk?.trigger === "Emergency" ? "Emergency path: the live price is three points past the line while the average lags. This is the one exception to wick protection." : null,
          "risk",
        )}
      {role === "viewer" && !liquidate?.available && !overdue?.available && !stalePriceNeeded && panel("Waiting for repayment", "Nothing to do here yet.", null, overdue?.reason ?? null)}
    </>
  );
}

function Panel({ title, body, children, error, receipt, busy, note, tone }: { title: string; body: string; children?: ReactNode; error?: string | null; receipt?: string | null; busy?: boolean; note?: string | null; tone?: "risk" }) {
  return (
    <section className={styles.panel} data-tone={tone}>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.body}>{body}</p>
      {children}
      {busy && <p role="status">Preparing, awaiting wallet approval, then confirming. Review your wallet to continue.</p>}
      {receipt && (
        <a href={signatureUrl(receipt)} target="_blank" rel="noreferrer">
          View transaction on Explorer ↗
        </a>
      )}
      {note && <p className={styles.note}>{note}</p>}
      <AnimatePresence>
        {error && (
          <m.p role="alert" className={styles.error} initial={{ opacity: 0 }} animate={{ opacity: 1, x: [0, -4, 4, -2, 0] }} exit={{ opacity: 0 }} transition={{ duration: 0.32 }}>
            {error}
          </m.p>
        )}
      </AnimatePresence>
    </section>
  );
}
