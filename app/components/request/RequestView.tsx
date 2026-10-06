"use client";

import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { LogoMark } from "@/components/brand/LogoMark";
import { Sharky } from "@/components/brand/Sharky";
import { RequestStatusPill } from "@/components/discover/RequestStatusPill";
import { HealthMeter } from "@/components/offer/HealthMeter";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Skeleton } from "@/components/ui/Skeleton";
import { useBalances, useDevConfig, usePrice } from "@/lib/client/hooks";
import { useRequest } from "@/lib/client/live";
import { useSigner } from "@/lib/client/signer-context";
import { atomsToNumber, fmt, formatBpsAsPercent, formatDuration, formatUsdc, formatWsol, shortKey } from "@/lib/format";
import { debt } from "@/lib/loan-math";
import { computeHealth } from "@/lib/offer-status";
import { requestPda } from "@/lib/pda";
import { requestAsOffer, requestStatusTitle, type LoanRequest } from "@/lib/requests";
import { priceUsd, solPriceAtLtv } from "@/lib/risk";
import { RequestActionPanel } from "./RequestActionPanel";
import styles from "@/components/offer/OfferView.module.css";

function keyFor(borrower: string, id: string): string | null {
  try {
    return requestPda(new PublicKey(borrower), BigInt(id)).toBase58();
  } catch {
    return null;
  }
}

export function RequestView({ borrower, requestId }: { borrower: string; requestId: string }) {
  const key = useMemo(() => keyFor(borrower, requestId), [borrower, requestId]);
  if (!key) return <Missing title="That request link is not valid" />;
  return <Loaded requestKey={key} />;
}

function Loaded({ requestKey }: { requestKey: string }) {
  const { request, error } = useRequest(requestKey);
  const { price } = usePrice();
  const { publicKey } = useSigner();
  const { config } = useDevConfig();
  const balances = useBalances(publicKey, config);
  const [moved, setMoved] = useState<string | null>(null);
  const viewer = publicKey?.toBase58() ?? null;
  useEffect(() => setMoved(null), [viewer]);

  if (error && request === undefined)
    return (
      <section role="alert">
        <h1>Request unavailable</h1>
        <p>Could not read this request from Devnet. Its state is unknown; this page retries by itself.</p>
      </section>
    );
  if (request === undefined) return <Loading />;
  if (request === null)
    return (
      <Missing
        title="This request is closed"
        body="The borrower closed it after it was funded or cancelled, so it no longer exists on chain."
      />
    );

  const isBorrower = viewer === request.borrower;
  const health = price && request.status === "open" ? computeHealth(requestAsOffer(request), price) : null;

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <Link href="/devnet/discover" className={styles.back}>
          ← Discover
        </Link>
        <header className={styles.head}>
          <div className={styles.pills}>
            <span className={styles.role}>
              {isBorrower ? "Your request" : request.status === "open" ? "You could fund this" : "You are viewing"}
            </span>
            <RequestStatusPill status={request.status} />
          </div>
          <m.h1
            key={request.status}
            className={styles.title}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            {request.status === "open" ? `Borrow ${formatUsdc(request.principal)} USDC` : requestStatusTitle(request.status)}
          </m.h1>
          <AnimatePresence>
            {moved && (
              <m.p
                className={styles.moved}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                <span className={styles.movedMark} aria-hidden>
                  <LogoMark size={18} progress={1} />
                </span>
                {moved}
              </m.p>
            )}
          </AnimatePresence>
        </header>

        <Figures request={request} lenderView={!isBorrower} />

        {health && (
          <section className={styles.block}>
            <p className={styles.blockNote}>If this request were funded at today&apos;s SOL price:</p>
            <HealthMeter
              ltvBps={health.currentLtvBps}
              healthBps={health.healthBps}
              maxLtvBps={request.maxLtvBps}
              liquidationLtvBps={request.liquidationLtvBps}
              stale={false}
              maxLabel="Max LTV at funding"
              liquidationPrice={solPriceAtLtv(debt(request.principal, request.interestBps), request.collateralAmount, request.liquidationLtvBps)}
              solPrice={price ? priceUsd(price) : null}
            />
          </section>
        )}

        <Terms request={request} />
      </div>
      <aside className={styles.aside}>
        <RequestActionPanel request={request} isBorrower={isBorrower} price={price} config={config} balances={balances} onMoved={setMoved} />
      </aside>
    </div>
  );
}

function Figures({ request: r, lenderView }: { request: LoanRequest; lenderView: boolean }) {
  const owed = debt(r.principal, r.interestBps);
  const items = lenderView
    ? [
        { label: "You lend", atoms: r.principal, d: 6, unit: "USDC", f: fmt.usd, exact: formatUsdc(r.principal) },
        { label: "You are repaid", atoms: owed, d: 6, unit: "USDC", f: fmt.usd, exact: formatUsdc(owed) },
        { label: "Collateral locked", atoms: r.collateralAmount, d: 9, unit: "wSOL", f: fmt.wsol, exact: formatWsol(r.collateralAmount) },
      ]
    : [
        { label: "You receive", atoms: r.principal, d: 6, unit: "USDC", f: fmt.usd, exact: formatUsdc(r.principal) },
        { label: "You repay", atoms: owed, d: 6, unit: "USDC", f: fmt.usd, exact: formatUsdc(owed) },
        { label: "wSOL you locked", atoms: r.collateralAmount, d: 9, unit: "wSOL", f: fmt.wsol, exact: formatWsol(r.collateralAmount) },
      ];
  return (
    <div className={styles.figures}>
      {items.map((it, i) => (
        <div key={it.label} className={`${styles.figure} ${i === 0 ? styles.figureHero : ""}`}>
          <span className={styles.figureLabel}>{it.label}</span>
          <span className={styles.figureValue}>
            <AnimatedNumber value={atomsToNumber(it.atoms, it.d)} format={it.f} exact={it.exact} className="num" />
            <span className={styles.unit}>{it.unit}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function Terms({ request: r }: { request: LoanRequest }) {
  const rows: [string, string, "num" | "address" | ""][] = [
    ["Interest for the whole term", formatBpsAsPercent(r.interestBps, 2), "num"],
    ["Term, from funding", formatDuration(r.durationSeconds), "num"],
    ["Max LTV at funding", formatBpsAsPercent(r.maxLtvBps), "num"],
    ["Liquidation LTV", formatBpsAsPercent(r.liquidationLtvBps), "num"],
    ["Borrower", shortKey(r.borrower), "address"],
    ["Lender", r.lender ? shortKey(r.lender) : "Not funded yet", r.lender ? "address" : ""],
    ["Request account", shortKey(r.publicKey), "address"],
  ];
  return (
    <section className={styles.block}>
      <h2 className={styles.blockTitle}>Terms</h2>
      <dl className={styles.terms}>
        {rows.map(([k, v, cls]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={cls}>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Loading() {
  return (
    <div className={styles.layout} aria-busy>
      <div className={styles.main}>
        <Skeleton width="5rem" height="1rem" />
        <Skeleton width="16rem" height="2.75rem" />
        <div className={styles.figures}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.figure}>
              <Skeleton width="6rem" height="0.875rem" />
              <Skeleton width="9rem" height="2rem" />
            </div>
          ))}
        </div>
      </div>
      <aside className={styles.aside}>
        <Skeleton width="100%" height="10rem" />
      </aside>
    </div>
  );
}

function Missing({ title, body }: { title: string; body?: string }) {
  return (
    <div className={styles.missing}>
      <Sharky pose="confused" size={120} />
      <h1 className={styles.title}>{title}</h1>
      {body && <p className={styles.sentence}>{body}</p>}
      <Link href="/devnet/discover" className={styles.back}>
        ← Back to Discover
      </Link>
    </div>
  );
}
