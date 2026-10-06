"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, m } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { LogoMark } from "@/components/brand/LogoMark";
import { OfferRow } from "@/components/offers/OfferRow";
import { Chips } from "@/components/ui/Chips";
import { Skeleton } from "@/components/ui/Skeleton";
import { Slider } from "@/components/ui/Slider";
import { usePrice } from "@/lib/client/hooks";
import { useLiveCards, useLiveOffers, useLiveRequests } from "@/lib/client/live";
import { useSigner } from "@/lib/client/signer-context";
import {
  DEFAULT_FILTERS,
  MAX_RATE_BPS,
  applyFilters,
  readView,
  type Facts,
  type Filters,
  type Side,
  type SortKey,
  type TermBucket,
  type Venue,
} from "@/lib/discover";
import { formatBpsAsPercent } from "@/lib/format";
import type { LiveStatus } from "@/lib/live-state";
import type { Offer } from "@/lib/offers";
import { SHOW, type Card } from "@/lib/private/discovery";
import type { LoanRequest } from "@/lib/requests";
import { LenderPrivateEmpty } from "./LenderPrivateEmpty";
import { LiveBadge } from "./LiveBadge";
import { PrivateCardList } from "./PrivateCardList";
import { RequestRow } from "./RequestRow";
import styles from "./Discover.module.css";
import list from "@/components/offers/OffersPage.module.css";

const requestFacts = (r: LoanRequest): Facts => ({
  amount: r.principal,
  rateBps: r.interestBps,
  durationSeconds: r.durationSeconds,
  ts: r.createdTs,
});
const offerFacts = (o: Offer): Facts => ({
  amount: o.principal,
  rateBps: o.interestBps,
  durationSeconds: o.durationSeconds,
  ts: 0,
});
const cardFacts = (c: Card): Facts => ({
  amount: c.fields.show & SHOW.amount ? c.fields.amountMax : null,
  rateBps: c.fields.show & SHOW.rate ? c.fields.maxInterestBps : null,
  durationSeconds: c.fields.show & SHOW.duration ? c.fields.durationSeconds : null,
  ts: 0,
});

const TERMS: { value: TermBucket; label: string }[] = [
  { value: "any", label: "Any term" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "1 week" },
  { value: "30d", label: "1 month" },
  { value: "90d", label: "3 months" },
];
const SORTS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "largest", label: "Largest" },
  { value: "rate", label: "Lowest rate" },
];

const COPY: Record<Side, Record<Venue, string>> = {
  borrowers: {
    public:
      "Borrowers who locked wSOL and posted their terms on chain. Fund one and the USDC goes straight to them; the loan starts at once.",
    private:
      "Borrowers negotiating inside sealed rooms. Each card shows only the fields its borrower chose to share. Ask to join to see the rest.",
  },
  lenders: {
    public: "Lenders who locked USDC and fixed every term up front. Lock the wSOL they ask for and borrow at once.",
    private: "Private lenders do not advertise. They reach borrowers by asking to join a room.",
  },
};

/** Status of the list currently on screen; the worse of two when a view reads two lists. */
const worst = (...s: LiveStatus[]): LiveStatus =>
  (["offline", "connecting", "polling", "live"] as LiveStatus[]).find((x) => s.includes(x)) ?? "connecting";

export function DiscoverPage() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { side, venue } = readView(params);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const { publicKey } = useSigner();
  const { price } = usePrice();
  const requests = useLiveRequests();
  const offers = useLiveOffers();
  const cards = useLiveCards();

  const setView = (next: { side?: Side; venue?: Venue }) => {
    const q = new URLSearchParams(params.toString());
    q.set("side", next.side ?? side);
    q.set("venue", next.venue ?? venue);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  const openRequests = useMemo(() => (requests.items ?? []).filter((r) => r.status === "open"), [requests.items]);
  const openOffers = useMemo(() => (offers.items ?? []).filter((o) => o.status === "open"), [offers.items]);
  const mine = useMemo(
    () => (requests.items ?? []).filter((r) => r.status !== "open" && r.borrower === publicKey?.toBase58()),
    [requests.items, publicKey]
  );

  const count = (n: number, loaded: boolean) => (loaded ? ` ${n}` : "");
  const sideCounts = {
    borrowers: openRequests.length + (cards.items?.length ?? 0),
    lenders: openOffers.length,
  };
  const status =
    side === "borrowers"
      ? venue === "public"
        ? requests.status
        : cards.status
      : venue === "public"
      ? offers.status
      : worst(offers.status);
  const showFilters = !(side === "lenders" && venue === "private");

  let body: ReactNode;
  if (side === "borrowers" && venue === "public") {
    body = (
      <ListState items={requests.items} error={requests.error} empty={<EmptyRequests />}>
        {(items) => (
          <Rows header={["Borrow", "Repays", "Term", "Collateral locked", "Status"]}>
            {applyFilters(items.filter((r) => r.status === "open"), requestFacts, filters).map((r) => ({
              key: r.publicKey,
              node: <RequestRow request={r} price={price} />,
            }))}
          </Rows>
        )}
      </ListState>
    );
  } else if (side === "borrowers") {
    body = (
      <ListState items={cards.items} error={cards.error} empty={<EmptyCards />}>
        {(items) => <PrivateCardList cards={applyFilters(items, cardFacts, filters)} />}
      </ListState>
    );
  } else if (venue === "public") {
    body = (
      <ListState items={offers.items} error={offers.error} empty={<EmptyOffers />}>
        {(items) => (
          <>
            <Rows header={["Principal", "Repay", "Term", "Collateral", "Status"]}>
              {applyFilters(items.filter((o) => o.status === "open"), offerFacts, filters).map((o) => ({
                key: o.publicKey,
                node: <OfferRow offer={o} price={price} />,
              }))}
            </Rows>
            <Link href="/devnet" className={styles.more}>
              All offers and loans in progress →
            </Link>
          </>
        )}
      </ListState>
    );
  } else {
    body = <LenderPrivateEmpty onSeeCards={() => setView({ side: "borrowers", venue: "private" })} />;
  }

  return (
    <div className="page">
      <section className={styles.intro}>
        <div className={styles.titleRow}>
          <div>
            <p className={styles.eyebrow}>
              <LiveBadge status={status} />
            </p>
            <h1 className={styles.title}>Discover</h1>
            <p className={styles.lede}>
              Every open loan on LegitShark, from both sides. Public terms are on chain for anyone to read. Private requests show
              only what the borrower chose to share.
            </p>
          </div>
          <div className={styles.actions}>
            {side === "borrowers" ? (
              <Link href="/devnet/discover/request" className={list.create}>
                Request a loan
              </Link>
            ) : (
              <Link href="/devnet/create" className={list.create}>
                Create offer
              </Link>
            )}
          </div>
        </div>

        <div className={styles.controls}>
          <div className={styles.sideSwitch}>
            <Chips
              label="Side"
              hideLabel
              options={[
                { value: "borrowers" as Side, label: `Borrowers asking${count(sideCounts.borrowers, requests.items !== null)}` },
                { value: "lenders" as Side, label: `Lenders offering${count(sideCounts.lenders, offers.items !== null)}` },
              ]}
              value={side}
              onChange={(s) => setView({ side: s })}
            />
          </div>
          <div className={styles.venueRow}>
            <Chips
              label="Where"
              hideLabel
              options={[
                {
                  value: "public" as Venue,
                  label: `Public${side === "borrowers" ? count(openRequests.length, requests.items !== null) : count(openOffers.length, offers.items !== null)}`,
                },
                {
                  value: "private" as Venue,
                  label: `Private${side === "borrowers" ? count(cards.items?.length ?? 0, cards.items !== null) : ""}`,
                },
              ]}
              value={venue}
              onChange={(v) => setView({ venue: v })}
            />
            <p className={styles.venueCopy}>{COPY[side][venue]}</p>
          </div>
        </div>
      </section>

      {showFilters && (
        <section className={styles.filters} aria-label="Filters">
          <div className={styles.rate}>
            <Slider
              label="Max interest for the term"
              value={filters.maxRateBps}
              min={0}
              max={MAX_RATE_BPS}
              step={50}
              onChange={(v) => setFilters((f) => ({ ...f, maxRateBps: v }))}
              format={(v) => (v >= MAX_RATE_BPS ? "Any" : `Up to ${formatBpsAsPercent(v)}`)}
            />
          </div>
          <Chips label="Term up to" options={TERMS} value={filters.term} onChange={(term) => setFilters((f) => ({ ...f, term }))} />
        </section>
      )}

      <section className={list.listSection} aria-label="Results">
        {showFilters && (
          <div className={styles.sortRow}>
            <Chips label="Sort" options={SORTS} value={filters.sort} onChange={(sort) => setFilters((f) => ({ ...f, sort }))} />
          </div>
        )}
        {body}
      </section>

      {side === "borrowers" && venue === "public" && mine.length > 0 && (
        <section className={styles.mine} aria-labelledby="mine-heading">
          <h2 id="mine-heading" className={styles.mineTitle}>
            Your settled requests
          </h2>
          <p className={styles.venueCopy}>Close these to take back the account rent.</p>
          <Rows header={["Borrow", "Repays", "Term", "Collateral locked", "Status"]}>
            {mine.map((r) => ({ key: r.publicKey, node: <RequestRow request={r} price={null} /> }))}
          </Rows>
        </section>
      )}
    </div>
  );
}

function ListState<T>({
  items,
  error,
  empty,
  children,
}: {
  items: T[] | null;
  error: string | null;
  empty: ReactNode;
  children: (items: T[]) => ReactNode;
}) {
  if (items === null && error)
    return (
      <div role="alert" className={list.empty}>
        <p className={list.emptyTitle}>Devnet is not answering</p>
        <p className={list.emptyBody}>Nothing here is lost. The list reloads by itself as soon as the network responds.</p>
      </div>
    );
  if (items === null)
    return (
      <div className={list.list} aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className={list.skeletonRow}>
            <Skeleton width="7rem" height="1.5rem" />
            <Skeleton width="5rem" height="1rem" />
            <Skeleton width="4rem" height="1rem" />
            <Skeleton width="6rem" height="1.5rem" />
          </div>
        ))}
      </div>
    );
  if (items.length === 0) return <>{empty}</>;
  return <>{children(items)}</>;
}

function Rows({ header, children }: { header: string[]; children: { key: string; node: ReactNode }[] }) {
  if (children.length === 0)
    return (
      <div className={list.empty}>
        <p className={list.emptyTitle}>Nothing matches these filters</p>
        <p className={list.emptyBody}>Raise the interest cap or pick a longer term.</p>
      </div>
    );
  return (
    <ul className={list.list}>
      <li className={list.header} aria-hidden>
        {header.map((h) => (
          <span key={h}>{h}</span>
        ))}
      </li>
      <AnimatePresence initial={false}>
        {children.map(({ key, node }) => (
          <m.li
            key={key}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] } }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
          >
            {node}
          </m.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function Empty({ title, body, href, cta }: { title: string; body: string; href: string; cta: string }) {
  return (
    <m.div className={list.empty} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <LogoMark size={48} progress={0.08} />
      <p className={list.emptyTitle}>{title}</p>
      <p className={list.emptyBody}>{body}</p>
      <Link href={href} className={list.emptyLink}>
        {cta}
      </Link>
    </m.div>
  );
}

const EmptyRequests = () => (
  <Empty
    title="No public requests yet"
    body="Borrowers lock wSOL and post the terms they want. Be the first: lenders see it here the moment it lands."
    href="/devnet/discover/request"
    cta="Request a loan"
  />
);
const EmptyCards = () => (
  <Empty
    title="No private requests yet"
    body="A borrower publishes a card from their private room, choosing which fields to show."
    href="/devnet/private"
    cta="Open a private room"
  />
);
const EmptyOffers = () => (
  <Empty
    title="No open offers"
    body="Lenders post offers here with every term fixed. Create one with test USDC."
    href="/devnet/create"
    cta="Create offer"
  />
);
