import type { Connection, GetProgramAccountsFilter, MemcmpFilter, PublicKey } from "@solana/web3.js";
import { debt } from "./loan-math";
import { debtOf, type PriceSnapshot } from "./offer-status";
import { legacyLoanView, v2LoanView } from "./models/loan-view";
import { offerV2Href, requestV2Href, type OfferV2, type RequestV2 } from "./v2/offers";
import { graceEnd, maturity, pricedRecoveryFrom, terminalClaimFrom, fullTermInterest } from "./loan-math-v2";
import { readOnlyProgram, supportedOfferMints, toOffer, type Offer } from "./offers";
import type { OfferAccount, RequestAccount } from "./program";
import { requestHref, toRequest, type LoanRequest } from "./requests";

/** Byte offsets of the wallet fields, discriminator included (checked against the IDL). */
export const OFFSETS = {
  offerLender: 8,
  offerBorrower: 40,
  requestBorrower: 8,
  requestLender: 151,
} as const;

export type Side = "lender" | "borrower";

/** The account filter that keeps only `wallet`'s side of an offer or request. */
export function walletFilter(kind: "offer" | "request", side: Side, wallet: string): MemcmpFilter {
  const offset =
    kind === "offer"
      ? side === "lender"
        ? OFFSETS.offerLender
        : OFFSETS.offerBorrower
      : side === "borrower"
        ? OFFSETS.requestBorrower
        : OFFSETS.requestLender;
  return { memcmp: { offset, bytes: wallet } };
}

type Namespace<A> = {
  all: (filters?: GetProgramAccountsFilter[]) => Promise<{ publicKey: PublicKey; account: A }[]>;
};

function namespaces(connection: Connection) {
  const account = readOnlyProgram(connection).account as unknown as {
    offer: Namespace<OfferAccount>;
    loanRequest: Namespace<RequestAccount>;
  };
  return { offer: account.offer, request: account.loanRequest };
}

/** Offers where `wallet` is the lender or the borrower, without loading every account. */
export async function fetchOffersBy(connection: Connection, side: Side, wallet: string): Promise<Offer[]> {
  const rows = await namespaces(connection).offer.all([walletFilter("offer", side, wallet)]);
  return rows.filter((r) => supportedOfferMints(r.account)).map((r) => toOffer(r.publicKey, r.account));
}

/** Requests where `wallet` is the borrower or the funding lender. */
export async function fetchRequestsBy(connection: Connection, side: Side, wallet: string): Promise<LoanRequest[]> {
  const rows = await namespaces(connection).request.all([walletFilter("request", side, wallet)]);
  return rows.filter((r) => supportedOfferMints(r.account)).map((r) => toRequest(r.publicKey, r.account));
}

/** Both sides at once, deduplicated by account. */
export async function fetchMine(connection: Connection, wallet: string): Promise<{ offers: Offer[]; requests: LoanRequest[] }> {
  const [ol, ob, rb, rl] = await Promise.all([
    fetchOffersBy(connection, "lender", wallet),
    fetchOffersBy(connection, "borrower", wallet),
    fetchRequestsBy(connection, "borrower", wallet),
    fetchRequestsBy(connection, "lender", wallet),
  ]);
  const uniq = <T extends { publicKey: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.publicKey, x])).values()];
  return { offers: uniq([...ol, ...ob]), requests: uniq([...rb, ...rl]) };
}

/** Lower is more urgent. */
export const URGENCY = {
  pastDue: 0,
  liquidatable: 1,
  dueSoon: 2,
  nearLine: 3,
  running: 4,
  open: 5,
  settled: 6,
} as const;

export type Urgency = (typeof URGENCY)[keyof typeof URGENCY];

export type PortfolioItem = {
  key: string;
  side: Side;
  kind: "offer" | "loan" | "request";
  urgency: Urgency;
  /** What needs doing, in plain words. */
  headline: string;
  /** The button label on the row. */
  action: string;
  href: string;
  /** Deadline, when the loan is running. */
  dueTs: number | null;
  counterparty: string | null;
  principal: bigint;
  /** Principal plus full-term interest. */
  owed: bigint;
  collateral: bigint;
  ltvBps: number | null;
  offer?: Offer;
  offerV2?: OfferV2;
  request?: LoanRequest;
};

export type PortfolioTotals = {
  lentOut: bigint;
  owedToYou: bigint;
  borrowed: bigint;
  youOwe: bigint;
  /** Earliest future deadline across running loans. */
  nextDueTs: number | null;
  /** Items at "near the line" urgency or more urgent. */
  attention: number;
};

const DAY = 86_400;
/** Health under this share of the distance to the line counts as near. */
const NEAR_HEALTH_BPS = 1_500;

export const offerHref = (o: Pick<Offer, "lender" | "offerId">) => `/devnet/offers/${o.lender}/${o.offerId}`;

function offerItem(o: Offer, me: string, price: PriceSnapshot | null, now: number): PortfolioItem | null {
  const side: Side | null = o.lender === me ? "lender" : o.borrower === me ? "borrower" : null;
  if (!side) return null;
  const base = {
    key: o.publicKey,
    side,
    href: offerHref(o),
    principal: o.principal,
    owed: debtOf(o),
    collateral: o.collateralAmount,
    offer: o,
  };
  if (o.status === "open") {
    // Only the lender has an open offer; a borrower appears once it is filled.
    return {
      ...base,
      kind: "offer",
      urgency: URGENCY.open,
      headline: "Waiting for a borrower",
      action: "Manage offer",
      dueTs: null,
      counterparty: null,
      ltvBps: null,
    };
  }
  if (o.status === "filled") {
    const view = legacyLoanView(o, price, now);
    const ltvBps = view.risk?.ltvBps ?? null;
    const past = !view.actions.some((a) => a.action === "repay" && a.available);
    const overLine = !!view.risk?.liquidatable;
    const near = !past && view.risk !== null && view.risk.healthBps <= NEAR_HEALTH_BPS;
    const soon = !past && o.expiryTs - now <= DAY;
    const counterparty = side === "lender" ? o.borrower : o.lender;
    const common = { ...base, owed: view.payoff, kind: "loan" as const, dueTs: o.expiryTs, counterparty, ltvBps };
    if (past)
      return side === "lender"
        ? { ...common, urgency: URGENCY.pastDue, headline: "Deadline passed. The collateral is yours to claim.", action: "Claim collateral" }
        : { ...common, urgency: URGENCY.pastDue, headline: "Deadline passed. Repayment is closed.", action: "View loan" };
    if (overLine)
      return side === "lender"
        ? { ...common, urgency: URGENCY.liquidatable, headline: "Past the liquidation line. Anyone can liquidate it now.", action: "View loan" }
        : { ...common, urgency: URGENCY.liquidatable, headline: "Past the liquidation line. Repay now to keep your wSOL.", action: "Repay" };
    if (soon)
      return side === "lender"
        ? { ...common, urgency: URGENCY.dueSoon, headline: "Due within a day.", action: "View loan" }
        : { ...common, urgency: URGENCY.dueSoon, headline: "Due within a day. If you do not repay by then, the lender receives your wSOL.", action: "Repay" };
    if (near)
      return side === "lender"
        ? { ...common, urgency: URGENCY.nearLine, headline: "Near the liquidation line.", action: "View loan" }
        : { ...common, urgency: URGENCY.nearLine, headline: "Near the liquidation line. Repaying early ends the risk.", action: "Repay" };
    return side === "lender"
      ? { ...common, urgency: URGENCY.running, headline: "Running. You are repaid at or before the deadline.", action: "View loan" }
      : { ...common, urgency: URGENCY.running, headline: "Running. Repay any time before the deadline.", action: "Repay" };
  }
  // Settled offers wait to be closed by the lender, which returns rent.
  const word = { repaid: "Repaid", expired: "Expired", liquidated: "Liquidated", cancelled: "Cancelled" }[o.status];
  return {
    ...base,
    kind: o.status === "cancelled" ? "offer" : "loan",
    urgency: URGENCY.settled,
    headline: side === "lender" ? `${word}. Close it to reclaim rent.` : `${word}.`,
    action: side === "lender" ? "Close and reclaim rent" : "View loan",
    dueTs: null,
    counterparty: side === "lender" ? o.borrower : o.lender,
    ltvBps: null,
  };
}

/** V2 loans: grace and the recovery windows change who must act and how soon. */
function offerV2Item(o: OfferV2, me: string, price: PriceSnapshot | null, now: number): PortfolioItem | null {
  const side: Side | null = o.currentLender === me ? "lender" : o.borrower === me ? "borrower" : null;
  if (!side) return null;
  const t = o.terms;
  const base = {
    key: o.publicKey,
    side,
    href: offerV2Href(o),
    principal: o.status === "active" ? o.ledger.outstandingPrincipal : t.principal,
    owed: t.principal + fullTermInterest(t),
    collateral: o.status === "open" ? o.collateralRequired : o.collateralLocked,
    offerV2: o,
    counterparty: side === "lender" ? o.borrower : o.currentLender,
  };
  if (o.status === "open")
    return { ...base, kind: "offer", urgency: URGENCY.open, headline: "Waiting for a borrower", action: "Manage offer", dueTs: null, counterparty: null, ltvBps: null };
  if (o.status !== "active") {
    return {
      ...base,
      kind: o.status === "cancelled" ? "offer" : "loan",
      urgency: URGENCY.settled,
      headline: side === "lender" ? "Settled. Close it to reclaim rent." : "Settled.",
      action: side === "lender" ? "Close and reclaim rent" : "View loan",
      dueTs: null,
      ltvBps: null,
    };
  }
  const view = v2LoanView(o, price, now);
  const common = { ...base, kind: "loan" as const, owed: view.payoff, ltvBps: view.risk?.ltvBps ?? null };
  const lender = side === "lender";
  switch (view.phase) {
    case "Terminal":
      return lender
        ? { ...common, urgency: URGENCY.pastDue, dueTs: terminalClaimFrom(t), headline: "The final claim is open. You may take all the wSOL.", action: "View loan" }
        : { ...common, urgency: URGENCY.pastDue, dueTs: terminalClaimFrom(t), headline: "The lender may now take all your wSOL. Repay now to keep it.", action: "Repay" };
    case "PricedRecovery":
      return lender
        ? { ...common, urgency: URGENCY.pastDue, dueTs: terminalClaimFrom(t), headline: "Priced recovery is open. You may take wSOL worth what is owed.", action: "View loan" }
        : { ...common, urgency: URGENCY.pastDue, dueTs: terminalClaimFrom(t), headline: "Priced recovery is open. The lender may take wSOL worth what you owe. Repay to keep it all.", action: "Repay" };
    case "Overdue":
      return lender
        ? { ...common, urgency: URGENCY.pastDue, dueTs: pricedRecoveryFrom(t), headline: "Grace has ended. Anyone may now settle it for you in USDC.", action: "View loan" }
        : { ...common, urgency: URGENCY.pastDue, dueTs: pricedRecoveryFrom(t), headline: "Grace has ended. Anyone may now pay your debt and take your wSOL plus 5%. Repay now.", action: "Repay" };
    case "Grace":
      return lender
        ? { ...common, urgency: URGENCY.pastDue, dueTs: graceEnd(t), headline: "Past the deadline, in grace. The late fee applies.", action: "View loan" }
        : { ...common, urgency: URGENCY.pastDue, dueTs: graceEnd(t), headline: "Past the deadline. Repay before grace ends to keep all your wSOL.", action: "Repay" };
    default:
      break;
  }
  const due = maturity(t);
  if (view.risk?.liquidatable)
    return lender
      ? { ...common, urgency: URGENCY.liquidatable, dueTs: due, headline: "Past the liquidation line. Anyone can liquidate it now.", action: "View loan" }
      : { ...common, urgency: URGENCY.liquidatable, dueTs: due, headline: "Past the liquidation line. Repay or add wSOL now.", action: "Repay" };
  if (due - now <= DAY)
    return lender
      ? { ...common, urgency: URGENCY.dueSoon, dueTs: due, headline: "Due within a day.", action: "View loan" }
      : { ...common, urgency: URGENCY.dueSoon, dueTs: due, headline: "Due within a day. After that a late fee applies.", action: "Repay" };
  if (view.risk && view.risk.healthBps <= NEAR_HEALTH_BPS)
    return lender
      ? { ...common, urgency: URGENCY.nearLine, dueTs: due, headline: "Near the liquidation line.", action: "View loan" }
      : { ...common, urgency: URGENCY.nearLine, dueTs: due, headline: "Near the liquidation line. Adding wSOL or repaying part lowers the risk.", action: "Repay" };
  return lender
    ? { ...common, urgency: URGENCY.running, dueTs: due, headline: "Waiting for repayment. Payments come straight to you.", action: "View loan" }
    : { ...common, urgency: URGENCY.running, dueTs: due, headline: "Waiting for repayment. Repay any part, any time.", action: "Repay" };
}

function requestItem(r: LoanRequest, me: string): PortfolioItem | null {
  // A funded request becomes a filled offer, which already appears as a loan.
  if (r.borrower !== me || r.status === "funded") return null;
  return {
    key: r.publicKey,
    side: "borrower",
    kind: "request",
    urgency: r.status === "open" ? URGENCY.open : URGENCY.settled,
    headline: r.status === "open" ? "Waiting for a lender to fund it." : "Cancelled. Close it to get your rent back.",
    action: r.status === "open" ? "Manage request" : "Close request",
    href: requestHref(r),
    dueTs: null,
    counterparty: null,
    principal: r.principal,
    owed: debt(r.principal, r.interestBps),
    collateral: r.collateralAmount,
    ltvBps: null,
    request: r,
  };
}

/** A V2 request keeps its management link until funded into a loan. */
function requestV2Item(r: RequestV2, me: string): PortfolioItem | null {
  if (r.borrower !== me || r.status === "funded") return null;
  return {
    key: r.publicKey, side: "borrower", kind: "request",
    urgency: r.status === "open" ? URGENCY.open : URGENCY.settled,
    headline: r.status === "open" ? "Waiting for a lender to fund it." : "Cancelled. Close it to get your rent back.",
    action: r.status === "open" ? "Manage request" : "Close request",
    href: requestV2Href(r), dueTs: null, counterparty: null,
    principal: r.terms.principal, owed: r.terms.principal + fullTermInterest(r.terms),
    collateral: r.status === "open" ? r.collateralAmount : 0n, ltvBps: null,
  };
}

/** Everything one wallet is part of, most urgent first, plus totals. */
export function buildPortfolio(input: {
  me: string;
  offers: Offer[];
  requests: LoanRequest[];
  offersV2?: OfferV2[];
  requestsV2?: RequestV2[];
  price: PriceSnapshot | null;
  now: number;
}): { items: PortfolioItem[]; totals: PortfolioTotals } {
  const { me, offers, requests, price, now } = input;
  const items = [
    ...offers.map((o) => offerItem(o, me, price, now)),
    ...(input.offersV2 ?? []).map((o) => offerV2Item(o, me, price, now)),
    ...requests.map((r) => requestItem(r, me)),
    ...(input.requestsV2 ?? []).map((r) => requestV2Item(r, me)),
  ]
    .filter((x): x is PortfolioItem => x !== null)
    .sort((a, b) => a.urgency - b.urgency || (a.dueTs ?? Infinity) - (b.dueTs ?? Infinity) || a.key.localeCompare(b.key));

  const running = items.filter((i) => i.kind === "loan" && (i.offer?.status === "filled" || i.offerV2?.status === "active"));
  const sum = (xs: PortfolioItem[], f: (i: PortfolioItem) => bigint) => xs.reduce((t, i) => t + f(i), 0n);
  const lending = running.filter((i) => i.side === "lender");
  const borrowing = running.filter((i) => i.side === "borrower");
  const future = running.map((i) => i.dueTs!).filter((t) => t > now);
  return {
    items,
    totals: {
      lentOut: sum(lending, (i) => i.principal),
      owedToYou: sum(lending, (i) => i.owed),
      borrowed: sum(borrowing, (i) => i.principal),
      youOwe: sum(borrowing, (i) => i.owed),
      nextDueTs: future.length ? Math.min(...future) : null,
      attention: items.filter((i) => i.urgency <= URGENCY.nearLine).length,
    },
  };
}

/** A calendar file for one deadline, so a borrower or lender gets a reminder. */
export function deadlineIcs(item: Pick<PortfolioItem, "key" | "side" | "dueTs" | "owed">, url: string): string | null {
  if (!item.dueTs) return null;
  const stamp = (t: number) => new Date(t * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const usdc = (Number(item.owed) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const summary = item.side === "borrower" ? `ZenLo: repay ${usdc} USDC` : `ZenLo: loan due (${usdc} USDC owed to you)`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ZenLo//My loans//EN",
    "BEGIN:VEVENT",
    `UID:${item.key}@zenlo`,
    `DTSTAMP:${stamp(item.dueTs - DAY)}`,
    `DTSTART:${stamp(item.dueTs - 3600)}`,
    `DTEND:${stamp(item.dueTs)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:The loan's last second is the end of this event. ${url}`,
    `URL:${url}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT23H",
    "ACTION:DISPLAY",
    `DESCRIPTION:${summary}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}
