"use client";

import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { messageFromAnchorError } from "@/lib/anchor-errors";
import { useBalances, useChainNow, useDevConfig, usePrice } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { formatBpsAsPercent, formatDeadline, formatDuration, formatUsdc, formatWsol, shortKey } from "@/lib/format";
import { collateralValueUsdc, currentLtvBps } from "@/lib/loan-math";
import { annualizedBps, EarlyRepayment, maxExposure } from "@/lib/loan-math-v2";
import { getConnection } from "@/lib/program";
import { sendPythUpdate } from "@/lib/pyth";
import { RequestService } from "@/lib/request-service";
import { SubmissionError, signatureUrl } from "@/lib/transaction-lifecycle";
import { decodeRequestV2, offerV2Href, type RequestV2 } from "@/lib/v2/offers";
import { requestV2Pda } from "@/lib/v2/program";
import { reviewFigures } from "@/lib/v2/rules";
import { sendCancelRequestV2, sendCloseRequestV2 } from "@/lib/v2/transactions";
import styles from "@/components/offer/OfferView.module.css";
import panel from "@/components/offer/ActionPanel.module.css";

export function RequestV2View({ borrower, requestId }: { borrower: string; requestId: string }) {
  const key = useMemo(() => {
    try {
      return requestV2Pda(new PublicKey(borrower), BigInt(requestId));
    } catch {
      return null;
    }
  }, [borrower, requestId]);
  const [request, setRequest] = useState<RequestV2 | null | undefined>(undefined);
  const { refreshKey, signer, publicKey, setConnectOpen, bumpRefresh } = useSigner();
  const { price } = usePrice();
  const now = useChainNow();
  const { config } = useDevConfig();
  const balances = useBalances(publicKey, config);
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    const load = () =>
      getConnection()
        .getAccountInfo(key)
        .then((info) => alive && setRequest(info ? decodeRequestV2(key, info.data as Buffer) : null))
        .catch(() => {});
    void load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [key, refreshKey]);

  if (!key) return <p className={styles.sentence}>That request link is not valid.</p>;
  if (request === undefined) return <Skeleton height="320px" />;
  if (request === null) return <p className={styles.sentence}>This request is closed.</p>;

  const t = request.terms;
  const mine = publicKey?.toBase58() === request.borrower;
  const f = reviewFigures(t, now ?? 0);
  const exposure = maxExposure(t);
  const fits = price ? currentLtvBps(exposure, collateralValueUsdc(request.collateralAmount, price.price, price.conf, price.exponent)) <= request.maxLtvBps : false;

  const run = async (fn: () => Promise<string>, done: string, after?: () => void) => {
    setError(null);
    setBusy(true);
    try {
      setReceipt(await fn());
      toast({ tone: "success", title: done });
      bumpRefresh();
      after?.();
    } catch (e) {
      setError(e instanceof SubmissionError ? e.message : messageFromAnchorError(e));
      if (e instanceof SubmissionError && e.signature) setReceipt(e.signature);
    } finally {
      setBusy(false);
    }
  };

  let action: React.ReactNode = null;
  if (!signer) action = <Button size="lg" block onClick={() => setConnectOpen(true)}>Connect wallet</Button>;
  else if (request.status === "open" && mine)
    action = (
      <Button variant="secondary" size="lg" block loading={busy} onClick={() => run(() => sendCancelRequestV2(signer, request), `Your ${formatWsol(request.collateralAmount)} wSOL is back`)}>
        Cancel request
      </Button>
    );
  else if (request.status === "open" && config)
    action = !price?.fresh ? (
      <Button variant="secondary" size="lg" block loading={busy} onClick={() => run(async () => (await sendPythUpdate(signer)).signatures.at(-1) ?? "", "A fresh SOL price is on chain")}>
        Post a fresh SOL price
      </Button>
    ) : (
      <Button
        size="lg"
        block
        loading={busy}
        disabled={!fits || (balances ? balances.usdc < t.principal : false)}
        onClick={() =>
          run(
            async () => {
              const r = await new RequestService(signer, config).fundV2(request);
              router.push(offerV2Href({ originLender: publicKey!.toBase58(), offerId: r.offerId }));
              return r.signature;
            },
            `You lent ${formatUsdc(t.principal)} USDC`,
          )
        }
      >
        Fund {formatUsdc(t.principal)} USDC
      </Button>
    );
  else if (request.status !== "open" && mine)
    action = (
      <Button variant="secondary" size="lg" block loading={busy} onClick={() => run(() => sendCloseRequestV2(signer, request), "Rent returned to your wallet")}>
        Close and reclaim rent
      </Button>
    );

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <Link href="/devnet/discover" className={styles.back}>
          ← Discover
        </Link>
        <h1 className={styles.title}>{request.status === "open" ? `${formatUsdc(t.principal)} USDC requested` : request.status === "funded" ? "Funded" : "Cancelled"}</h1>
        <dl className={styles.terms}>
          <div><dt>Borrower</dt><dd className="num">{shortKey(request.borrower)}</dd></div>
          <div><dt>Collateral locked</dt><dd className="num">{formatWsol(request.collateralAmount)} wSOL</dd></div>
          <div><dt>Term cost</dt><dd className="num">{formatUsdc(f.termCost)} USDC for {formatDuration(t.duration)}</dd></div>
          <div><dt>Annualized pricing</dt><dd className="num">{formatBpsAsPercent(annualizedBps(t), 1)}</dd></div>
          <div><dt>Early repayment</dt><dd>{t.earlyRepayment === EarlyRepayment.ProRata ? `Interest for time used, at least ${formatUsdc(f.minInterest)} USDC` : "Full-term interest"}</dd></div>
          <div><dt>Grace, late fee</dt><dd className="num">{formatDuration(t.graceSeconds)}, {formatBpsAsPercent(t.lateFeeBps, 2)}</dd></div>
          <div><dt>Annual pricing ceiling</dt><dd className="num">{formatBpsAsPercent(t.annualCeilingBps, 0)}</dd></div>
          <div><dt>Max / liquidation LTV</dt><dd className="num">{formatBpsAsPercent(request.maxLtvBps, 0)} / {formatBpsAsPercent(request.liquidationLtvBps, 0)}</dd></div>
        </dl>
        {request.status === "open" && now !== null && (
          <p className={styles.blockNote}>
            Funded now: deadline {formatDeadline(f.maturity)}, grace ends {formatDeadline(f.graceEnd)}, final whole-collateral claim from {formatDeadline(f.terminalClaimFrom)}.
          </p>
        )}
        {request.status === "funded" && request.lender && <p className={styles.blockNote}>Funded by {shortKey(request.lender)}. The loan now lives in My loans for both wallets.</p>}
      </div>
      <aside className={styles.aside}>
        <section className={panel.panel}>
          <h2 className={panel.title}>{mine ? "Your request" : "Fund this request"}</h2>
          <p className={panel.body}>
            {mine
              ? "Your wSOL is locked until a lender funds it or you cancel."
              : `Lend ${formatUsdc(t.principal)} USDC from your own wallet. The borrower's wSOL moves into the loan at once.`}
          </p>
          {request.status === "open" && !mine && price?.fresh && !fits && <p className={panel.note}>At today&apos;s SOL price this collateral does not cover the most this loan can cost.</p>}
          {action}
          {receipt && (
            <a href={signatureUrl(receipt)} target="_blank" rel="noreferrer">
              View transaction on Explorer ↗
            </a>
          )}
          {error && (
            <p role="alert" className={panel.error}>
              {error}
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}
