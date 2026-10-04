"use client";

import Link from "next/link";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { LogoMark } from "@/components/brand/LogoMark";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Skeleton } from "@/components/ui/Skeleton";
import { useBalances, useChainNow, useDevConfig, useOffer, usePrice } from "@/lib/client/hooks";
import { useSigner } from "@/lib/client/signer-context";
import { EXPIRY_SENTENCE } from "@/lib/constants";
import { atomsToNumber, fmt, formatBpsAsPercent, formatDeadline, formatDuration, shortKey } from "@/lib/format";
import { computeHealth, debtOf, statusTitle } from "@/lib/offer-status";
import type { Offer } from "@/lib/offers";
import { offerPda } from "@/lib/pda";
import { priceUsd, solPriceAtLtv } from "@/lib/risk";
import { PublicKey } from "@solana/web3.js";
import { ActionPanel } from "./ActionPanel";
import { HealthMeter } from "./HealthMeter";
import { TermRing } from "./TermRing";
import { roleFor, type OfferRole } from "./useOfferRole";
import styles from "./OfferView.module.css";

function keyFor(lender: string, id: string): string | null {
  try {
    return offerPda(new PublicKey(lender), BigInt(id)).toBase58();
  } catch {
    return null;
  }
}

export function OfferView({ lender, offerId }: { lender: string; offerId: string }) {
  const key = useMemo(() => keyFor(lender, offerId), [lender, offerId]);
  if (!key) return <Missing title="That offer link is not valid" />;
  return <Loaded offerKey={key} />;
}

function Loaded({ offerKey }: { offerKey: string }) {
  const { offer } = useOffer(offerKey);
  const { price } = usePrice();
  const now = useChainNow(price);
  const { publicKey } = useSigner();
  const { config } = useDevConfig();
  const balances = useBalances(publicKey, config);
  const [moved, setMoved] = useState<string | null>(null);
  const signerKey = publicKey?.toBase58() ?? null;
  // "What moved" belongs to whoever signed it; a new signer starts clean.
  useEffect(() => setMoved(null), [signerKey]);

  if (offer === undefined) return <Loading />;
  if (offer === null) return <Missing title="This offer is closed" body="The lender closed it after it settled, so it no longer exists on chain." />;

  const role = roleFor(offer, publicKey?.toBase58() ?? null);
  const expired = offer.status === "filled" && now >= offer.expiryTs;
  const health = price && ["open", "filled"].includes(offer.status) ? computeHealth(offer, price) : null;

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <Link href="/" className={styles.back}>
          ← Offers
        </Link>

        <header className={styles.head}>
          <div className={styles.pills}>
            <span className={styles.role}>{roleLabel(role, offer)}</span>
            {expired && <span className={styles.expiredTag}>Past the deadline</span>}
          </div>
          {/* Keyed so a new status rises in; no exit phase, so a fast poll can never strand the old title. */}
          <m.h1
            key={offer.status}
            className={styles.title}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            {statusTitle(offer.status)}
          </m.h1>
          <AnimatePresence>
            {moved && (
              <m.p
                className={styles.moved}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                <span className={styles.movedMark} aria-hidden>
                  <LogoMark size={18} progress={1} />
                </span>
                {moved}
              </m.p>
            )}
          </AnimatePresence>
        </header>

        <Figures offer={offer} role={role} />

        {offer.status === "open" && role !== "lender" && (
          <p className={styles.deadlineLine}>
            Taken now, repay by <b>{formatDeadline(now + offer.durationSeconds)}</b>. {EXPIRY_SENTENCE}
          </p>
        )}

        {offer.status === "filled" && (
          <section className={styles.block}>
            <TermRing startTs={offer.startTs} expiryTs={offer.expiryTs} now={now} />
            {role === "borrower" && !expired && <p className={styles.sentence}>{EXPIRY_SENTENCE}</p>}
          </section>
        )}

        {health && (
          <section className={styles.block}>
            {offer.status === "open" && <p className={styles.blockNote}>If this offer were taken at today&apos;s SOL price:</p>}
            <HealthMeter
              ltvBps={health.currentLtvBps}
              healthBps={health.healthBps}
              maxLtvBps={offer.maxLtvBps}
              liquidationLtvBps={offer.liquidationLtvBps}
              stale={!price?.fresh}
              liquidationPrice={solPriceAtLtv(debtOf(offer), offer.collateralAmount, offer.liquidationLtvBps)}
              solPrice={price ? priceUsd(price) : null}
            />
          </section>
        )}

        <Terms offer={offer} />
      </div>

      <aside className={styles.aside}>
        <ActionPanel
          offer={offer}
          role={role}
          price={price}
          now={now}
          config={config}
          balances={balances}
          onMoved={setMoved}
        />
      </aside>
    </div>
  );
}

function roleLabel(role: OfferRole, offer: Offer) {
  if (role === "lender") return "You are the lender";
  if (role === "borrower") return "You are the borrower";
  return offer.status === "open" ? "You could borrow this" : "You are viewing";
}

function Figures({ offer, role }: { offer: Offer; role: OfferRole }) {
  const owed = debtOf(offer);
  const borrowerView = role === "borrower" || (role === "visitor" && offer.status === "open");
  const taken = offer.status !== "open";
  const items = borrowerView
    ? [
        { label: taken ? "USDC you received" : "USDC you receive", value: atomsToNumber(offer.principal, 6), unit: "USDC", f: fmt.usd },
        {
          label: offer.status === "filled" ? "USDC you owe" : taken ? "USDC owed" : "USDC you repay",
          value: atomsToNumber(owed, 6),
          unit: "USDC",
          f: fmt.usd,
        },
        { label: taken ? "wSOL you locked" : "wSOL you lock", value: atomsToNumber(offer.collateralAmount, 9), unit: "wSOL", f: fmt.wsol },
      ]
    : [
        { label: role === "lender" ? "You lent" : "Principal", value: atomsToNumber(offer.principal, 6), unit: "USDC", f: fmt.usd },
        { label: role === "lender" ? "You are owed" : "Debt", value: atomsToNumber(owed, 6), unit: "USDC", f: fmt.usd },
        { label: "Collateral", value: atomsToNumber(offer.collateralAmount, 9), unit: "wSOL", f: fmt.wsol },
      ];
  return (
    <div className={styles.figures}>
      {items.map((it, i) => (
        <div key={it.label} className={`${styles.figure} ${i === 0 ? styles.figureHero : ""}`}>
          <span className={styles.figureLabel}>{it.label}</span>
          <span className={styles.figureValue}>
            <AnimatedNumber value={it.value} format={it.f} className="num" />
            <span className={styles.unit}>{it.unit}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function Terms({ offer }: { offer: Offer }) {
  const rows = [
    ["Interest for the whole term", formatBpsAsPercent(offer.interestBps, 2)],
    ["Term", formatDuration(offer.durationSeconds)],
    ["Max LTV at accept", formatBpsAsPercent(offer.maxLtvBps)],
    ["Liquidation LTV", formatBpsAsPercent(offer.liquidationLtvBps)],
    ["Lender", shortKey(offer.lender)],
    ["Borrower", offer.borrower ? shortKey(offer.borrower) : "Not taken yet"],
    ["Offer account", shortKey(offer.publicKey)],
  ];
  return (
    <section className={styles.block}>
      <h2 className={styles.blockTitle}>Terms</h2>
      <dl className={styles.terms}>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="num">{v}</dd>
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
      <LogoMark size={44} progress={1} />
      <h1 className={styles.title}>{title}</h1>
      {body && <p className={styles.sentence}>{body}</p>}
      <Link href="/" className={styles.back}>
        ← Back to offers
      </Link>
    </div>
  );
}
