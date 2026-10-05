"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { offerHref } from "@/components/offers/OfferRow";
import { Button } from "@/components/ui/Button";
import { messageFromAnchorError } from "@/lib/anchor-errors";
import { useOffer, type Balances, type DevConfig, type LivePrice } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { formatUsdc, formatWsol } from "@/lib/format";
import { computeHealth } from "@/lib/offer-status";
import { sendPythUpdate } from "@/lib/pyth";
import { RequestService } from "@/lib/request-service";
import { requestAsOffer, type LoanRequest } from "@/lib/requests";
import { SubmissionError, signatureUrl } from "@/lib/transaction-lifecycle";
import styles from "@/components/offer/ActionPanel.module.css";
import discover from "@/components/discover/Discover.module.css";

type Props = {
  request: LoanRequest;
  isBorrower: boolean;
  price: LivePrice | null;
  config: DevConfig | null;
  balances: Balances | null;
  onMoved: (line: string) => void;
};

/** One primary action for the request's state and the person looking at it. */
export function RequestActionPanel({ request: r, isBorrower, price, config, balances, onMoved }: Props) {
  const { signer, setConnectOpen, bumpRefresh } = useSigner();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const service = () => {
    if (!signer || !config) throw new Error("Connect a wallet and verify network configuration first.");
    return new RequestService(signer, config);
  };

  const run = async (fn: () => Promise<string>, moved: string) => {
    setError(null);
    setBusy(true);
    try {
      const signature = await fn();
      setReceipt(signature);
      setConfirming(false);
      onMoved(moved);
      toast({ tone: "success", title: moved });
      bumpRefresh();
    } catch (e) {
      setError(e instanceof SubmissionError ? e.message : messageFromAnchorError(e));
      if (e instanceof SubmissionError && e.signature) setReceipt(e.signature);
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const panel = (p: { title: string; body: string; note?: string | null; children?: ReactNode }) => (
    <section className={styles.panel}>
      <h2 className={styles.title}>{p.title}</h2>
      <p className={styles.body}>{p.body}</p>
      {p.children}
      {busy && <p role="status">{step ?? "Preparing, awaiting wallet approval, then confirming. Review your wallet to continue."}</p>}
      {receipt && (
        <a href={signatureUrl(receipt)} target="_blank" rel="noreferrer">
          View transaction on Explorer ↗
        </a>
      )}
      {p.note && <p className={styles.note}>{p.note}</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </section>
  );

  const closeButton = (
    <Button
      variant="secondary"
      size="lg"
      block
      loading={busy}
      disabled={!signer}
      onClick={() => run(() => service().close(r), "Request closed. The account rent is back in your wallet.")}
    >
      Close request
    </Button>
  );

  if (r.status === "funded") return <Funded request={r} isBorrower={isBorrower} panel={panel} closeButton={closeButton} />;

  if (r.status === "cancelled")
    return panel({
      title: "Cancelled",
      body: isBorrower
        ? "Your wSOL is back in your wallet. Close the request to take back its account rent."
        : "The borrower withdrew this request and took back their wSOL.",
      children: isBorrower ? closeButton : null,
    });

  // Open.
  if (isBorrower)
    return panel({
      title: "Waiting for a lender",
      body: `Your ${formatWsol(r.collateralAmount)} wSOL is locked in the request's vault. Cancel at any time before someone funds it.`,
      children: confirming ? (
        <div className={styles.confirm}>
          <p className={styles.confirmQ}>Return the wSOL to your wallet?</p>
          <div className={styles.row}>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Keep request
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => run(() => service().cancel(r), `You received ${formatWsol(r.collateralAmount)} wSOL back`)}
            >
              Return wSOL
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" size="lg" block onClick={() => setConfirming(true)}>
          Cancel request
        </Button>
      ),
    });

  if (!signer)
    return panel({
      title: "Connect to fund",
      body: "Connect the Devnet wallet that holds the USDC you want to lend.",
      children: (
        <Button size="lg" block onClick={() => setConnectOpen(true)}>
          Connect to fund
        </Button>
      ),
    });

  const fits = !price || computeHealth(requestAsOffer(r), price).currentLtvBps <= r.maxLtvBps;
  const enough = !balances || balances.usdc >= r.principal;
  const stale = !price?.fresh;
  const reason = !fits
    ? "At today's SOL price the locked wSOL is past the borrower's max LTV, so funding would be refused. Wait for SOL to recover or for the borrower to post more."
    : !enough
    ? `You hold ${formatUsdc(balances!.usdc)} USDC. This request needs ${formatUsdc(r.principal)}.`
    : null;
  return panel({
    title: "Fund this request",
    body: `Send ${formatUsdc(r.principal)} USDC to the borrower now. Their ${formatWsol(
      r.collateralAmount
    )} wSOL moves into the loan's vault, and the term starts at once.`,
    note:
      reason ??
      (stale
        ? "The SOL price on Devnet is older than 60 seconds. Funding first posts a fresh price, which asks your wallet for a few extra signatures."
        : null),
    children: (
      <Button
        size="lg"
        block
        loading={busy}
        disabled={Boolean(reason)}
        onClick={() =>
          run(async () => {
            if (stale) {
              setStep("Posting a fresh SOL price. Approve each wallet request.");
              await sendPythUpdate(signer);
            }
            setStep("Funding. Approve the transaction in your wallet.");
            return (await service().fund(r)).signature;
          }, `You lent ${formatUsdc(r.principal)} USDC`)
        }
      >
        Fund this request
      </Button>
    ),
  });
}

function Funded({
  request: r,
  isBorrower,
  panel,
  closeButton,
}: {
  request: LoanRequest;
  isBorrower: boolean;
  panel: (p: { title: string; body: string; children?: ReactNode }) => ReactNode;
  closeButton: ReactNode;
}) {
  const { offer } = useOffer(r.offer ?? "");
  return panel({
    title: "Funded. This is a loan now.",
    body: isBorrower
      ? `You received ${formatUsdc(r.principal)} USDC. Repay from the loan page before the deadline to get your wSOL back.`
      : `The borrower received ${formatUsdc(r.principal)} USDC. Repayment, expiry and liquidation happen on the loan page.`,
    children: (
      <div className={styles.confirm}>
        {offer ? (
          <Link href={offerHref(offer)} className={discover.more}>
            Open the loan →
          </Link>
        ) : (
          <p role="status">Finding the loan…</p>
        )}
        {isBorrower && closeButton}
      </div>
    ),
  });
}
