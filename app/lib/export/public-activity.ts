/**
 * Public activity rows (Story 26.8), rebuilt from chain: the wallet's V2 loans, each loan's
 * signatures, and the program events in each transaction's logs. The mapping from events to rows
 * (`eventsToRows`) is pure and processes each loan's events in `(slot, signature)` order, so the
 * same chain data always yields the same rows. Only the RPC is contacted; no ZenLo server is.
 */
import { EventParser } from "@coral-xyz/anchor";
import { PublicKey, type Connection } from "@solana/web3.js";
import { NATIVE_WSOL_MINT } from "../constants";
import { fetchOffersV2, type OfferV2 } from "../v2/offers";
import { PROGRAM_V2_ID, readOnlyProgramV2 } from "../v2/program";
import { atomsToDecimal, compareCursor, isoUtc, normalize, type ActivityRow, type Role } from "./activity";

/** One program event with the transaction it came from. */
export type ChainEvent = {
  slot: number;
  signature: string;
  blockTime: number;
  /** Lamports. */
  fee: number;
  feePayer: string;
  name: string;
  data: Record<string, unknown>;
};

/** The loan facts the mapper needs; taken from the current `OfferV2`, which never changes them. */
export type LoanFacts = Pick<OfferV2, "publicKey" | "originLender" | "borrower" | "wsolMint" | "terms">;

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** Reads a field whether the coder produced camelCase or snake_case names. */
function field(d: Record<string, unknown>, camel: string): unknown {
  if (camel in d) return d[camel];
  const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return d[snake];
}
const big = (d: Record<string, unknown>, k: string): bigint => {
  const v = field(d, k);
  return v === undefined || v === null ? 0n : BigInt((v as { toString(): string }).toString());
};
const key = (d: Record<string, unknown>, k: string): string => {
  const v = field(d, k) as { toBase58?: () => string } | string | undefined;
  return typeof v === "string" ? v : (v?.toBase58?.() ?? "");
};
const variant = (v: unknown): string => (v && typeof v === "object" ? lowerFirst(Object.keys(v as object)[0] ?? "") : String(v ?? ""));

const collateralLabel = (mint: string) => (mint === NATIVE_WSOL_MINT.toBase58() ? "wSOL" : "jitoSOL");

/**
 * Rows for `wallet` from one loan's events. Events are replayed in order to know who held the
 * position at each moment, so a seller stops receiving rows for payments after the sale.
 */
export function eventsToRows(wallet: string, loan: LoanFacts, events: ChainEvent[]): ActivityRow[] {
  const ordered = [...events].sort((a, b) => compareCursor(a, b));
  const out: ActivityRow[] = [];
  let holder = loan.originLender;
  let status = "open";
  const collateral = collateralLabel(loan.wsolMint);
  for (const e of ordered) {
    const d = e.data;
    const name = lowerFirst(e.name);
    const push = (role: Role, action: string, asset: string, atoms: bigint, decimals: number) =>
      out.push({
        timeUtc: isoUtc(e.blockTime),
        slot: e.slot,
        signature: e.signature,
        loan: loan.publicKey,
        role,
        action,
        asset,
        amountAtoms: atoms.toString(),
        amountDecimal: atomsToDecimal(atoms, decimals),
        fee: e.feePayer === wallet ? String(e.fee) : "0",
        status,
      });
    const usdc = (role: Role, action: string, atoms: bigint) => push(role, action, "USDC", atoms, 6);
    const coll = (role: Role, action: string, atoms: bigint) => push(role, action, collateral, atoms, 9);
    const isBorrower = wallet === loan.borrower;
    switch (name) {
      case "offerCreatedV2":
        status = "open";
        if (wallet === loan.originLender) usdc("lender", "create-offer", big(d, "principal"));
        break;
      case "acceptedV2":
        status = "active";
        // Started by a refinance: the principal went to the old lender, not the borrower.
        if (isBorrower) usdc("borrower", ordered.some((x) => x.signature === e.signature && lowerFirst(x.name) === "refinancedV2") ? "borrow-by-refinance" : "borrow", loan.terms.principal);
        if (wallet === loan.originLender) usdc("lender", "lend", loan.terms.principal);
        break;
      case "paymentV2": {
        if (field(d, "closed") === true) status = "repaid";
        const used = big(d, "used");
        if (isBorrower) usdc("borrower", "repay", used);
        if (wallet === holder) usdc("lender", "receive-repayment", used);
        break;
      }
      case "collateralAddedV2":
        if (isBorrower) coll("borrower", "add-collateral", big(d, "amount"));
        break;
      case "settledV2": {
        status = variant(field(d, "status"));
        const paid = big(d, "paid");
        const toRecipient = big(d, "toRecipient");
        const toBorrower = big(d, "toBorrower");
        if (status === "repaid" || status === "cancelled") break; // covered by the payment or offer rows
        if (status === "refinanced") break; // covered by the refinance event
        if (isBorrower) coll("borrower", `settle-${status}-collateral-returned`, toBorrower);
        if (status === "liquidated" || status === "overdueLiquidated") {
          if (wallet === holder) usdc("lender", `settle-${status}`, paid);
          if (e.feePayer === wallet && wallet !== holder && !isBorrower) {
            usdc("liquidator", `settle-${status}-paid`, paid);
            coll("liquidator", `settle-${status}-received`, toRecipient);
          }
        } else if (wallet === holder) coll("lender", `settle-${status}`, toRecipient);
        if (wallet === holder && big(d, "shortfall") > 0n) usdc("lender", "shortfall", big(d, "shortfall"));
        break;
      }
      case "refinancedV2": {
        const oldOffer = key(d, "oldOffer");
        if (oldOffer === loan.publicKey) {
          status = "refinanced";
          if (isBorrower) usdc("borrower", "refinance-contribution", big(d, "contribution"));
          if (wallet === holder) usdc("lender", "receive-refinance-payoff", big(d, "payoffOld"));
        }
        break;
      }
      case "positionListedV2":
        if (key(d, "seller") === wallet) usdc("seller", "list-position", big(d, "price"));
        break;
      case "positionSoldV2": {
        const seller = key(d, "seller");
        const buyer = key(d, "buyer");
        const price = big(d, "price");
        if (seller === wallet) usdc("seller", "sell-position", price);
        if (buyer === wallet) usdc("buyer", "buy-position", price);
        holder = buyer;
        break;
      }
      case "listingClosedV2":
        if (key(d, "seller") === wallet) usdc("seller", field(d, "cancelled") === true ? "cancel-listing" : "listing-closed", 0n);
        break;
      case "mandateExecuted": {
        const repay = Number(field(d, "action")) === 1;
        const amount = big(d, "amount");
        const fee = big(d, "fee");
        if (isBorrower) {
          if (repay) usdc("borrower", "mandate-repay", amount);
          else coll("borrower", "mandate-top-up", amount);
          if (fee > 0n) (repay ? usdc : coll)("borrower", "keeper-fee", fee);
        }
        if (repay && wallet === holder && amount > 0n) usdc("lender", "receive-repayment", amount);
        if (e.feePayer === wallet && !isBorrower && fee > 0n) (repay ? usdc : coll)("keeper", "keeper-fee", fee);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const LIMIT = 1000;

/** Every signature that touched `address`, newest first, paging with `before`. */
async function allSignatures(connection: Connection, address: PublicKey): Promise<{ signature: string; slot: number; err: unknown }[]> {
  const out: { signature: string; slot: number; err: unknown }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await connection.getSignaturesForAddress(address, { before, limit: LIMIT }, "confirmed");
    out.push(...page);
    if (page.length < LIMIT) return out;
    before = page[page.length - 1].signature;
  }
}

/** Program events of one transaction. */
async function eventsOf(connection: Connection, signature: string, parser: EventParser): Promise<ChainEvent[]> {
  const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx || tx.meta?.err || !tx.meta?.logMessages) return [];
  const feePayer = tx.transaction.message.staticAccountKeys[0]?.toBase58() ?? "";
  const events: ChainEvent[] = [];
  for (const ev of parser.parseLogs(tx.meta.logMessages)) {
    events.push({ slot: tx.slot, signature, blockTime: tx.blockTime ?? 0, fee: tx.meta.fee, feePayer, name: ev.name, data: ev.data as Record<string, unknown> });
  }
  return events;
}

/** Public rows for `wallet` across its V2 loans (as origin lender, current lender or borrower). */
export async function publicActivityRows(connection: Connection, wallet: string): Promise<ActivityRow[]> {
  const sides = ["originLender", "currentLender", "borrower"] as const;
  const found = (await Promise.all(sides.map((side) => fetchOffersV2(connection, { side, wallet })))).flat();
  const offers = [...new Map(found.map((o) => [o.publicKey, o])).values()];
  const parser = new EventParser(PROGRAM_V2_ID, readOnlyProgramV2(connection).coder);
  const rows: ActivityRow[] = [];
  for (const o of offers) {
    const sigs = (await allSignatures(connection, new PublicKey(o.publicKey))).filter((s) => !s.err);
    const events = (await Promise.all(sigs.map((s) => eventsOf(connection, s.signature, parser)))).flat();
    // A transaction can touch two loans (refinance); keep only this loan's events.
    const mine = events.filter((e) => {
      const offer = key(e.data, "offer") || key(e.data, "oldOffer");
      return offer === o.publicKey || key(e.data, "newOffer") === o.publicKey;
    });
    rows.push(...eventsToRows(wallet, o, mine));
  }
  return normalize(rows);
}
