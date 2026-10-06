"use client";

import Link from "next/link";
import { AnimatePresence, m } from "motion/react";
import { useMemo, useState } from "react";
import { Spot } from "@/components/brand/Spot";
import { Chips } from "@/components/ui/Chips";
import { Skeleton } from "@/components/ui/Skeleton";
import { useOffers, usePrice } from "@/lib/client/hooks";
import type { Offer } from "@/lib/offers";
import { OfferRow } from "./OfferRow";
import styles from "./OffersPage.module.css";

type Filter = "open" | "filled" | "ended" | "all";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "open", label: "Open offers" },
  { value: "filled", label: "Waiting for repayment" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All" },
];

const STEPS = [
  {
    title: "A lender locks USDC",
    body: "They set the amount, the interest for the whole term, and the wSOL a borrower must lock.",
  },
  {
    title: "A borrower takes it",
    body: "They lock the wSOL and receive the USDC at once. The deadline starts now.",
  },
  {
    title: "The loan settles",
    body: "Repay in time and get the wSOL back. Miss it, or let SOL fall past the line, and the lender is paid from the wSOL.",
  },
];

function matches(o: Offer, f: Filter) {
  if (f === "all") return true;
  if (f === "ended") return !["open", "filled"].includes(o.status);
  return o.status === f;
}

export function OffersPage() {
  const { offers, error } = useOffers();
  const { price } = usePrice();
  const [filter, setFilter] = useState<Filter>("open");
  const shown = useMemo(
    () => (offers ?? []).filter((o) => matches(o, filter)),
    [offers, filter]
  );
  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      open: 0,
      filled: 0,
      ended: 0,
      all: offers?.length ?? 0,
    };
    for (const o of offers ?? []) {
      if (o.status === "open") c.open++;
      else if (o.status === "filled") c.filled++;
      else c.ended++;
    }
    return c;
  }, [offers]);

  return (
    <div className="page">
      <section className={styles.intro}>
        <div className={styles.titleRow}>
          <div>
            <h1 className={styles.title}>Offers</h1>
            <p className={styles.lede}>
              Fixed-term USDC loans against wSOL. One offer is one loan, with
              every number fixed up front.
            </p>
          </div>
          <Link href="/devnet/create" className={styles.create}>
            Create offer
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path
                d="M3 7h8M7.5 3.5L11 7l-3.5 3.5"
                stroke="currentColor"
                strokeWidth="1.75"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>
        <ol className={styles.steps}>
          {STEPS.map((s, i) => (
            <li key={s.title} className={styles.step}>
              <span className={`${styles.stepIndex} num`}>{i + 1}</span>
              <div>
                <p className={styles.stepTitle}>{s.title}</p>
                <p className={styles.stepBody}>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.listSection} aria-labelledby="list-heading">
        <div className={styles.listHead}>
          <h2 id="list-heading" className="visually-hidden">
            Offer list
          </h2>
          <Chips
            label="Show"
            hideLabel
            options={FILTERS.map((f) => ({
              value: f.value,
              label: `${f.label}${offers ? ` ${counts[f.value]}` : ""}`,
            }))}
            value={filter}
            onChange={setFilter}
          />
        </div>

        {error ? (
          <div role="alert" className={styles.empty}>
            <h2>Offers unavailable</h2>
            <p>
              Could not read the network. Your offers may still exist. Use Retry
              connection above.
            </p>
          </div>
        ) : offers === null ? (
          <div className={styles.list}>
            {[0, 1, 2].map((i) => (
              <div key={i} className={styles.skeletonRow}>
                <Skeleton width="7rem" height="1.5rem" />
                <Skeleton width="5rem" height="1rem" />
                <Skeleton width="4rem" height="1rem" />
                <Skeleton width="6rem" height="1.5rem" />
              </div>
            ))}
          </div>
        ) : shown.length === 0 ? (
          <m.div
            className={styles.empty}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <Spot kind={error ? "notFound" : "waiting"} size={120} />
            <p className={styles.emptyTitle}>
              {filter === "open" ? "No open offers" : "Nothing here yet"}
            </p>
            <p className={styles.emptyBody}>
              {error
                ? "ZenLo cannot reach the configured network. Retry the connection above."
                : "Lenders post offers here. Create one with test USDC, or return later for a new offer."}
            </p>
            <Link href="/devnet/create" className={styles.emptyLink}>
              Create offer
            </Link>
          </m.div>
        ) : (
          <ul className={styles.list}>
            <li className={styles.header} aria-hidden>
              <span>Principal</span>
              <span>Repay</span>
              <span>Term</span>
              <span>Collateral</span>
              <span>Status</span>
            </li>
            <AnimatePresence initial={true}>
              {shown.map((o, i) => (
                <m.li
                  key={o.publicKey}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: {
                      delay: Math.min(i, 8) * 0.04,
                      duration: 0.32,
                      ease: [0.22, 1, 0.36, 1],
                    },
                  }}
                  exit={{ opacity: 0, transition: { duration: 0.12 } }}
                >
                  <OfferRow offer={o} price={price} />
                </m.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>
    </div>
  );
}
