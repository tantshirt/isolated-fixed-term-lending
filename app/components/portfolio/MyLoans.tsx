"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Spot } from "@/components/brand/Spot";
import { AssetLabel } from "@/components/brand/AssetLabel";
import { LiveBadge } from "@/components/discover/LiveBadge";
import { Button } from "@/components/ui/Button";
import { useSigner } from "@/lib/client/signer-context";
import { formatBpsAsPercent, formatCountdown, formatDeadline, formatUsdc, formatWsol, shortKey } from "@/lib/format";
import { URGENCY, deadlineIcs, type PortfolioItem, type Side } from "@/lib/portfolio";
import { PrivateDesk } from "./PrivateDesk";
import { CashPanel } from "@/components/cash/CashPanel";
import { ShieldPanel } from "@/components/shield/ShieldPanel";
import { useBalances, useDevConfig } from "@/lib/client/hooks";
import { usePortfolio } from "./usePortfolio";
import s from "./MyLoans.module.css";

const TONE: Record<number, string> = {
  [URGENCY.pastDue]: "urgent",
  [URGENCY.liquidatable]: "urgent",
  [URGENCY.dueSoon]: "warn",
  [URGENCY.nearLine]: "warn",
  [URGENCY.running]: "running",
  [URGENCY.open]: "open",
  [URGENCY.settled]: "done",
};

const KIND_WORD = { offer: "Offer", loan: "Loan", request: "Request" } as const;

function saveIcs(item: PortfolioItem) {
  const url = `${window.location.origin}${item.href}`;
  const ics = deadlineIcs(item, url);
  if (!ics) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = `zenlo-deadline-${item.key.slice(0, 8)}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1_000);
}

function Row({ item, now }: { item: PortfolioItem; now: number }) {
  const tone = TONE[item.urgency];
  const left = item.dueTs ? item.dueTs - now : null;
  return (
    <li className={s.row} data-tone={tone}>
      <div className={s.rowMain}>
        <div className={s.rowHead}>
          <span className={s.kind}>{KIND_WORD[item.kind]}</span>
          {item.counterparty && (
            <span className={s.counterparty}>
              {item.side === "lender" ? "Borrower" : "Lender"} <span className="mono">{shortKey(item.counterparty)}</span>
            </span>
          )}
        </div>
        <p className={s.headline}>{item.headline}</p>
        <dl className={s.figures}>
          <div>
            <dt>{item.kind === "request" ? "Asking" : item.kind === "offer" ? "Offering" : item.side === "lender" ? "Lent" : "Borrowed"}</dt>
            <dd className="num">
              <AssetLabel symbol="USDC">{formatUsdc(item.principal)} USDC</AssetLabel>
            </dd>
          </div>
          <div>
            <dt>{item.side === "lender" ? "Owed to you" : "You repay"}</dt>
            <dd className="num">{formatUsdc(item.owed)} USDC</dd>
          </div>
          <div>
            <dt>Collateral</dt>
            <dd className="num">{formatWsol(item.collateral)} wSOL</dd>
          </div>
          {item.ltvBps !== null && (
            <div>
              <dt>LTV now</dt>
              <dd className="num">{formatBpsAsPercent(item.ltvBps)}</dd>
            </div>
          )}
        </dl>
      </div>
      <div className={s.rowSide}>
        {item.dueTs && (
          <div className={s.clock}>
            <span className={s.clockLabel}>{left !== null && left > 0 ? "Time left" : "Deadline"}</span>
            <span className={`${s.clockValue} num`}>{left !== null && left > 0 ? formatCountdown(left) : "Passed"}</span>
            <span className={s.clockDate}>{formatDeadline(item.dueTs)}</span>
          </div>
        )}
        <div className={s.rowActions}>
          <Link className={s.action} data-tone={tone} href={item.href}>
            {item.action}
          </Link>
          {item.dueTs && left !== null && left > 0 && (
            <button type="button" className={s.calendar} onClick={() => saveIcs(item)}>
              Add to calendar
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function Empty({ side }: { side: Side }) {
  return (
    <div className={s.empty}>
      <Spot kind="waiting" size={120} />
      {side === "lender" ? (
        <>
          <h3>Nothing lent yet</h3>
          <p>Post an offer and wait for a borrower, or fund a borrower who already asked.</p>
          <div className={s.emptyActions}>
            <Link className={s.action} href="/devnet/create">
              Create offer
            </Link>
            <Link className={s.secondaryLink} href="/devnet/discover?side=borrowers">
              See borrowers asking
            </Link>
          </div>
        </>
      ) : (
        <>
          <h3>Nothing borrowed yet</h3>
          <p>Take an open offer, or post a request with your own terms and let lenders fund it.</p>
          <div className={s.emptyActions}>
            <Link className={s.action} href="/devnet/discover?side=lenders">
              See open offers
            </Link>
            <Link className={s.secondaryLink} href="/devnet/discover/request">
              Request a loan
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

export function MyLoans() {
  const { setConnectOpen, publicKey } = useSigner();
  const { config } = useDevConfig();
  const cashBalances = useBalances(publicKey, config);
  const { wallet, portfolio, now, status, error } = usePortfolio();
  const [side, setSide] = useState<Side | null>(null);

  const items = portfolio?.items ?? [];
  const bySide = (x: Side) => items.filter((i) => i.side === x);
  const attentionOn = (x: Side) => bySide(x).filter((i) => i.urgency <= URGENCY.nearLine).length;

  // Open on the side that needs you most, once the list first arrives.
  useEffect(() => {
    if (side || !portfolio) return;
    const l = attentionOn("lender"),
      b = attentionOn("borrower");
    setSide(b > l ? "borrower" : l > 0 || bySide("lender").length >= bySide("borrower").length ? "lender" : "borrower");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolio, side]);

  // A different wallet starts fresh.
  useEffect(() => setSide(null), [wallet]);

  if (!wallet)
    return (
      <div className="page">
        <section className={s.connect}>
          <Spot kind="waiting" size={140} />
          <h1>My loans</h1>
          <p>
            Connect your wallet once and ZenLo remembers it. Every offer, loan and request you are part of shows up here,
            with its deadline and what to do next.
          </p>
          <Button size="lg" onClick={() => setConnectOpen(true)}>
            Connect wallet
          </Button>
        </section>
      </div>
    );

  const t = portfolio?.totals;
  const current = side ?? "lender";
  const list = bySide(current);
  const attention = t?.attention ?? 0;

  return (
    <div className="page">
      <header className={s.head}>
        <div className={s.headText}>
          <LiveBadge status={status} />
          <h1>My loans</h1>
          <p>
            Everything <span className="mono">{shortKey(wallet)}</span> lends and borrows on Devnet, with what needs you
            first.
          </p>
        </div>
        <div className={s.headActions}>
          <Link className={s.secondaryLink} href="/devnet/discover/request">
            Request a loan
          </Link>
          <Link className={s.action} href="/devnet/create">
            Create offer
          </Link>
        </div>
      </header>

      {error && <p role="alert" className={s.error}>Devnet is not answering. {portfolio ? "These are the last received figures; current balances and loan states are unverified." : "Your loans could not be checked."} This page retries every 15 seconds.</p>}

      <h2 className={s.totalsTitle}>Public loans</h2>
      <section className={s.totals} aria-label="Public totals">
        <div className={s.total}>
          <span>Lent out</span>
          <strong className="num">{t ? formatUsdc(t.lentOut) : "…"} USDC</strong>
        </div>
        <div className={s.total}>
          <span>Owed to you</span>
          <strong className="num">{t ? formatUsdc(t.owedToYou) : "…"} USDC</strong>
        </div>
        <div className={s.total}>
          <span>Borrowed</span>
          <strong className="num">{t ? formatUsdc(t.borrowed) : "…"} USDC</strong>
        </div>
        <div className={s.total}>
          <span>You owe</span>
          <strong className="num">{t ? formatUsdc(t.youOwe) : "…"} USDC</strong>
        </div>
        <div className={`${s.total} ${s.totalNavy}`}>
          <span>Next deadline</span>
          <strong className="num">{!t ? "Checking…" : t.nextDueTs ? formatCountdown(t.nextDueTs - now) : "None"}</strong>
        </div>
      </section>

      {attention > 0 && (
        <p className={s.attention} role="status">
          {attention === 1 ? "1 item needs" : `${attention} items need`} your attention. They are at the top of the list.
        </p>
      )}

      <div className={s.tabs} role="group" aria-label="Side">
        {(["lender", "borrower"] as const).map((x) => (
          <button
            key={x}
            type="button"
            aria-pressed={current === x}
            className={s.tab}
            onClick={() => setSide(x)}
          >
            {x === "lender" ? "Lending" : "Borrowing"} <span className={s.count}>{bySide(x).length}</span>
            {attentionOn(x) > 0 && <span className={s.dot} aria-label={`${attentionOn(x)} need attention`} />}
          </button>
        ))}
      </div>

      {portfolio === null ? (
        <p role="status" className={s.loading}>{error ? "Waiting for Devnet to recover…" : "Reading your loans from Devnet…"}</p>
      ) : list.length === 0 ? (
        <Empty side={current} />
      ) : (
        <ul className={s.list} aria-label={current === "lender" ? "Lending" : "Borrowing"}>
          {list.map((item) => (
            <Row key={item.key} item={item} now={now} />
          ))}
        </ul>
      )}

      <PrivateDesk />

      <CashPanel direction="out" usdcBalance={cashBalances?.usdc ?? null} />
      {/* Cash-in funds a repayment; repaying stays a separate step on the loan's page. */}
      {bySide("borrower").length > 0 && <CashPanel direction="in" usdcBalance={cashBalances?.usdc ?? null} />}
      <ShieldPanel wsolBalance={cashBalances?.wsol ?? null} />


      <p className={s.note}>
        Closed accounts leave the chain, so settled loans disappear here once they are closed. Your wallet history keeps
        the transactions.
      </p>
    </div>
  );
}
