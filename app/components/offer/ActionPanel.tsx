"use client";

import { AnimatePresence, m } from "motion/react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { messageFromAnchorError } from "@/lib/anchor-errors";
import type { Balances, DevConfig, LivePrice } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { STALE_PRICE_MESSAGE } from "@/lib/constants";
import { formatUsdc, formatWsol } from "@/lib/format";
import {
  canAcceptAtPrice,
  canLiquidate,
  debtOf,
  liquidationFigures,
} from "@/lib/offer-status";
import type { Offer } from "@/lib/offers";
import { DevnetLoanService } from "@/lib/devnet-loan-service";
import type { LoanAction } from "@/lib/loan-service";
import { SubmissionError, signatureUrl } from "@/lib/transaction-lifecycle";
import type { OfferRole } from "./useOfferRole";
import styles from "./ActionPanel.module.css";

type Props = {
  offer: Offer;
  role: OfferRole;
  price: LivePrice | null;
  now: number | null;
  config: DevConfig | null;
  balances: Balances | null;
  onMoved: (line: string) => void;
};

/** Re-stamps the local mock right before a price-reading instruction. */
async function freshenPrice() {
  await fetch("/api/price?keepFresh=1", { cache: "no-store" }).catch(() => {});
}

/**
 * One primary action for the current state and the person looking at it,
 * placed last in the reading order. Everything else is a text button.
 */
export function ActionPanel({
  offer,
  role,
  price,
  now,
  config,
  balances,
  onMoved,
}: Props) {
  const { signer, setConnectOpen, bumpRefresh } = useSigner();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const executeLoan = async (action: LoanAction): Promise<string> => {
    if (!signer || !config)
      throw new Error(
        "Connect a wallet and verify network configuration first."
      );
    const receipt = await new DevnetLoanService(signer, config, offer).execute({
      action,
    });
    return receipt.signature!;
  };
  const owed = debtOf(offer);
  const expired =
    offer.status === "filled" && now !== null && now >= offer.expiryTs;

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
      setError(
        e instanceof SubmissionError ? e.message : messageFromAnchorError(e)
      );
      if (e instanceof SubmissionError && e.signature) setReceipt(e.signature);
    } finally {
      setBusy(false);
    }
  };

  const connect = (label: string) => (
    <Panel
      title="Connect to continue"
      body="Connect the wallet that should sign this step."
    >
      <Button size="lg" block onClick={() => setConnectOpen(true)}>
        {label}
      </Button>
    </Panel>
  );

  // ---- Open offer ----
  if (offer.status === "open") {
    if (role === "lender") {
      return (
        <Panel
          title="Waiting for a borrower"
          body="Your USDC sits in the offer's vault. Cancel at any time before someone accepts."
          error={error}
          receipt={receipt}
          busy={busy}
        >
          <AnimatePresence mode="wait" initial={false}>
            {confirming ? (
              <m.div key="confirm" className={styles.confirm} {...swap}>
                <p className={styles.confirmQ}>
                  Return the USDC to your wallet?
                </p>
                <div className={styles.row}>
                  <Button
                    variant="ghost"
                    onClick={() => setConfirming(false)}
                    disabled={busy}
                  >
                    Keep offer
                  </Button>
                  <Button
                    variant="danger"
                    loading={busy}
                    onClick={() =>
                      run(
                        () => executeLoan("cancel"),
                        `You received ${formatUsdc(offer.principal)} USDC back`
                      )
                    }
                  >
                    Return USDC
                  </Button>
                </div>
              </m.div>
            ) : (
              <m.div key="cancel" {...swap}>
                <Button
                  variant="secondary"
                  size="lg"
                  block
                  onClick={() => setConfirming(true)}
                  disabled={!signer}
                >
                  Cancel offer
                </Button>
              </m.div>
            )}
          </AnimatePresence>
        </Panel>
      );
    }
    if (!signer) return connect("Connect to borrow");
    const fresh = Boolean(price?.fresh);
    const fits = canAcceptAtPrice(offer, price);
    const enough = !balances || balances.wsol >= offer.collateralAmount;
    const reason = !fresh
      ? STALE_PRICE_MESSAGE
      : !fits
      ? "At today's SOL price this collateral is past the offer's max LTV. The lender asked for more cushion than SOL can give right now."
      : !enough
      ? `You hold ${formatWsol(
          balances!.wsol
        )} wSOL. This offer needs ${formatWsol(offer.collateralAmount)}.`
      : null;
    return (
      <Panel
        title="Take this loan"
        body={`Lock ${formatWsol(
          offer.collateralAmount
        )} wSOL and receive ${formatUsdc(offer.principal)} USDC now.`}
        error={error}
        receipt={receipt}
        busy={busy}
        note={reason}
      >
        <Button
          size="lg"
          block
          loading={busy}
          disabled={Boolean(reason)}
          onClick={() =>
            run(async () => {
              await freshenPrice();
              return executeLoan("accept");
            }, `You received ${formatUsdc(offer.principal)} USDC`)
          }
        >
          Lock wSOL and borrow
        </Button>
      </Panel>
    );
  }

  // ---- Filled loan ----
  if (offer.status === "filled") {
    if (now === null)
      return (
        <Panel
          title="Chain clock unavailable"
          body="Repayment, liquidation, and expiry claims pause until the network clock can be read. Oracle availability does not affect repayment."
          error={error}
          receipt={receipt}
          busy={busy}
        />
      );
    if (expired) {
      if (role === "borrower") {
        return (
          <Panel
            title="The deadline has passed"
            body="The loan can no longer be repaid. The lender can now claim your wSOL."
          />
        );
      }
      if (!signer) return connect("Connect to claim");
      return (
        <Panel
          title="Ready to claim"
          body={`The borrower did not repay in time. Claiming sends all ${formatWsol(
            offer.collateralAmount
          )} wSOL to the lender.`}
          error={error}
          receipt={receipt}
          busy={busy}
        >
          <Button
            size="lg"
            block
            loading={busy}
            onClick={() =>
              run(
                () => executeLoan("claim"),
                role === "lender"
                  ? `You received ${formatWsol(offer.collateralAmount)} wSOL`
                  : "The lender received the wSOL"
              )
            }
          >
            Claim collateral
          </Button>
        </Panel>
      );
    }

    if (role === "borrower") {
      const short = balances && balances.usdc < owed;
      return (
        <Panel
          title="Repay to get your wSOL back"
          body={`Pay ${formatUsdc(
            owed
          )} USDC before the deadline. You receive your wSOL back.`}
          error={error}
          receipt={receipt}
          busy={busy}
          note={
            short
              ? `You hold ${formatUsdc(
                  balances!.usdc
                )} USDC, short of ${formatUsdc(owed)}.`
              : null
          }
        >
          <AnimatePresence mode="wait" initial={false}>
            {confirming ? (
              <m.div key="confirm" className={styles.confirm} {...swap}>
                <dl className={styles.sheet}>
                  <div>
                    <dt>You pay</dt>
                    <dd className="num">{formatUsdc(owed)} USDC</dd>
                  </div>
                  <div>
                    <dt>You receive</dt>
                    <dd className="num">
                      {formatWsol(offer.collateralAmount)} wSOL
                    </dd>
                  </div>
                </dl>
                <div className={styles.row}>
                  <Button
                    variant="ghost"
                    onClick={() => setConfirming(false)}
                    disabled={busy}
                  >
                    Not yet
                  </Button>
                  <Button
                    loading={busy}
                    onClick={() =>
                      run(
                        () => executeLoan("repay"),
                        `You received ${formatWsol(
                          offer.collateralAmount
                        )} wSOL back`
                      )
                    }
                  >
                    Repay {formatUsdc(owed)} USDC
                  </Button>
                </div>
              </m.div>
            ) : (
              <m.div key="repay" {...swap}>
                <Button
                  size="lg"
                  block
                  disabled={Boolean(short)}
                  onClick={() => setConfirming(true)}
                >
                  Repay
                </Button>
              </m.div>
            )}
          </AnimatePresence>
        </Panel>
      );
    }

    // The lender cannot be the caller: their USDC account would be both payer and payee,
    // which Anchor rejects as a duplicate mutable account.
    if (role === "lender" && canLiquidate(offer, price, now)) {
      return (
        <Panel
          title="Past the liquidation line"
          body={`Any liquidator can settle this loan now. When they do, you receive ${formatUsdc(
            owed
          )} USDC in full.`}
          tone="risk"
        />
      );
    }

    if (canLiquidate(offer, price, now) && price) {
      const f = liquidationFigures(offer, price);
      return (
        <Panel
          title="This loan can be liquidated"
          body="SOL has fallen past the liquidation line. Anyone but the borrower can settle it now."
          error={error}
          receipt={receipt}
          busy={busy}
          tone="risk"
        >
          <dl className={styles.sheet}>
            <div>
              <dt>USDC you pay the lender</dt>
              <dd className="num">{formatUsdc(f.payUsdc)}</dd>
            </div>
            <div>
              <dt>wSOL you receive</dt>
              <dd className="num">{formatWsol(f.receiveWsol)}</dd>
            </div>
            <div>
              <dt>wSOL returned to the borrower</dt>
              <dd className="num">{formatWsol(f.returnWsol)}</dd>
            </div>
          </dl>
          {signer ? (
            <Button
              size="lg"
              block
              loading={busy}
              onClick={() =>
                run(async () => {
                  await freshenPrice();
                  return executeLoan("liquidate");
                }, `You received ${formatWsol(f.receiveWsol)} wSOL`)
              }
            >
              Pay the lender and take collateral
            </Button>
          ) : (
            <Button size="lg" block onClick={() => setConnectOpen(true)}>
              Connect to liquidate
            </Button>
          )}
        </Panel>
      );
    }

    return (
      <Panel
        title={
          role === "lender" ? "Your loan is running" : "Waiting for repayment"
        }
        body={
          role === "lender"
            ? "You are paid when the borrower repays. If they miss the deadline, or SOL falls past the line, the wSOL settles it."
            : "The borrower has until the deadline to repay."
        }
      />
    );
  }

  // ---- Settled ----
  if (role === "lender") {
    return (
      <Panel
        title="This loan is settled"
        body="The offer account stays on chain as your receipt. Close it to take back its rent."
        error={error}
        receipt={receipt}
        busy={busy}
      >
        <Button
          variant="ghost"
          loading={busy}
          disabled={!signer}
          onClick={() =>
            run(() => executeLoan("close"), "Receipt closed, rent returned")
          }
        >
          Close and reclaim rent
        </Button>
      </Panel>
    );
  }
  return (
    <Panel
      title="This loan is settled"
      body="Nothing more can happen to it."
      error={error}
      receipt={receipt}
      busy={busy}
    />
  );
}

const swap = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.18 },
};

function Panel({
  title,
  body,
  children,
  error,
  receipt,
  busy,
  note,
  tone,
}: {
  title: string;
  body: string;
  children?: ReactNode;
  error?: string | null;
  receipt?: string | null;
  busy?: boolean;
  note?: string | null;
  tone?: "risk";
}) {
  return (
    <section className={styles.panel} data-tone={tone}>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.body}>{body}</p>
      {children}
      {busy && (
        <p role="status">
          Preparing, awaiting wallet approval, then confirming. Review your
          wallet to continue.
        </p>
      )}
      {receipt && (
        <a href={signatureUrl(receipt)} target="_blank" rel="noreferrer">
          View transaction on Explorer ↗
        </a>
      )}
      {note && <p className={styles.note}>{note}</p>}
      <AnimatePresence>
        {error && (
          <m.p
            role="alert"
            className={styles.error}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, x: [0, -4, 4, -2, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.32 }}
          >
            {error}
          </m.p>
        )}
      </AnimatePresence>
    </section>
  );
}
