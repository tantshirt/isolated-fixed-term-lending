/**
 * Public activity rows (Story 26.8), rebuilt from historical transactions, including closed loans
 * and former holdings. Ownership follows block transaction order; the (slot, signature) export
 * cursor is applied afterwards. Only the RPC is contacted; no ZenLo server is.
 */
import { BorshInstructionCoder, EventParser } from "@coral-xyz/anchor";
import { PublicKey, type Connection } from "@solana/web3.js";
import { NATIVE_WSOL_MINT } from "../constants";
import type { OfferV2 } from "../v2/offers";
import { PROGRAM_V2_ID, readOnlyProgramV2 } from "../v2/program";
import { atomsToDecimal, isoUtc, normalize, type ActivityRow, type Role } from "./activity";

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
  /** Position in the block and log stream, independent of signature sort order. */
  transactionIndex?: number;
  eventIndex?: number;
};

/** The loan facts the mapper needs; taken from the current `OfferV2`, which never changes them. */
export type LoanFacts = Pick<OfferV2, "publicKey" | "originLender" | "borrower" | "wsolMint"> & {
  terms: Pick<OfferV2["terms"], "principal"> & Partial<OfferV2["terms"]>;
};

/** Replay in chain execution order. A signature is an export cursor, not an ordering oracle. */
function compareEvents(a: ChainEvent, b: ChainEvent): number {
  if (a.slot !== b.slot) return a.slot - b.slot;
  if (a.signature === b.signature) return (a.eventIndex ?? 0) - (b.eventIndex ?? 0);
  if (a.transactionIndex === undefined || b.transactionIndex === undefined) throw new Error("Block transaction order is unavailable.");
  return a.transactionIndex - b.transactionIndex;
}

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
  const ordered = [...events].sort(compareEvents);
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
        const accounted = ordered.some((x) => x.signature === e.signature && lowerFirst(x.name) === (repay ? "paymentV2" : "collateralAddedV2"));
        if (isBorrower) {
          // execute_mandate also emits the normal accounting event for this same movement.
          if (!accounted) {
            if (repay) usdc("borrower", "mandate-repay", amount);
            else coll("borrower", "mandate-top-up", amount);
          }
          if (fee > 0n) (repay ? usdc : coll)("borrower", "keeper-fee", fee);
        }
        if (!accounted && repay && wallet === holder && amount > 0n) usdc("lender", "receive-repayment", amount);
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

export type ArchivedInstruction = { name: string; accounts: Record<string, string>; data: Record<string, unknown> };
export type ArchivedTransaction = { events: ChainEvent[]; instructions: ArchivedInstruction[] };

/** Historical discovery includes former owners and closed loans; it does not inspect live accounts. */
export function discoveredLoans(transactions: ArchivedTransaction[]): string[] {
  const loans = new Set<string>();
  for (const tx of transactions) {
    for (const e of tx.events) for (const fieldName of ["offer", "oldOffer", "newOffer"]) {
      const address = key(e.data, fieldName);
      if (address) loans.add(address);
    }
    for (const ix of tx.instructions) for (const fieldName of ["offer", "oldOffer", "newOffer"]) {
      const address = ix.accounts[fieldName];
      if (address) loans.add(address);
    }
  }
  return [...loans];
}

/** Only immutable origination facts are required to replay an account after it has closed. */
export function archivedLoanFacts(loan: string, transactions: ArchivedTransaction[], requestTransactions: ArchivedTransaction[] = []): LoanFacts {
  const instructions = transactions.flatMap((t) => t.instructions);
  const create = instructions.find((i) => i.name === "createOffer" && i.accounts.offer === loan);
  const fund = instructions.find((i) => i.name === "fundRequest" && i.accounts.offer === loan);
  const request = fund && requestTransactions.flatMap((t) => t.instructions).find((i) => i.name === "createRequest" && i.accounts.request === fund.accounts.request);
  const origin = create ?? fund;
  const args = field((create ?? request)?.data ?? {}, "args") as Record<string, unknown> | undefined;
  if (!origin || !args || field(args, "principal") === undefined || !origin.accounts.lender || !origin.accounts.wsolMint) {
    throw new Error("Loan origination history is unavailable. Use an archival RPC and try again.");
  }
  const accepted = transactions.flatMap((t) => t.events).find((e) => lowerFirst(e.name) === "acceptedV2" && key(e.data, "offer") === loan);
  return { publicKey: loan, originLender: origin.accounts.lender, borrower: accepted ? key(accepted.data, "borrower") : null, wsolMint: origin.accounts.wsolMint, terms: { principal: big(args, "principal") } };
}

const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** RPC seam permits historical replay tests without a live node. */
export type ActivityArchive = {
  transactionsFor: (address: string) => Promise<ArchivedTransaction[]>;
  blockSignatures: (slot: number) => Promise<string[]>;
};

export async function replayPublicActivity(wallet: string, archive: ActivityArchive): Promise<ActivityRow[]> {
  const rows: ActivityRow[] = [];
  const blocks = new Map<number, Promise<string[]>>();
  for (const loan of discoveredLoans(await archive.transactionsFor(wallet))) {
    const transactions = await archive.transactionsFor(loan);
    const fund = transactions.flatMap((t) => t.instructions).find((i) => i.name === "fundRequest" && i.accounts.offer === loan);
    const facts = archivedLoanFacts(loan, transactions, fund ? await archive.transactionsFor(fund.accounts.request) : []);
    // A refinance touches two loans; replay only the events for this loan.
    const events = transactions.flatMap((t) => t.events).filter((e) => ["offer", "oldOffer", "newOffer"].some((f) => key(e.data, f) === loan));
    const signaturesBySlot = new Map<number, Set<string>>();
    for (const e of events) {
      if (!signaturesBySlot.has(e.slot)) signaturesBySlot.set(e.slot, new Set());
      signaturesBySlot.get(e.slot)!.add(e.signature);
    }
    for (const [slot, signatures] of signaturesBySlot) {
      if (signatures.size < 2) continue;
      if (!blocks.has(slot)) blocks.set(slot, archive.blockSignatures(slot));
      const order = await blocks.get(slot)!;
      for (const e of events.filter((e) => e.slot === slot)) {
        const transactionIndex = order.indexOf(e.signature);
        if (transactionIndex < 0) throw new Error("Block transaction order is unavailable.");
        e.transactionIndex = transactionIndex;
      }
    }
    rows.push(...eventsToRows(wallet, facts, events));
  }
  // Cursor sorting follows accounting replay and can never influence ownership attribution.
  return normalize(rows);
}

/** Rebuild public activity using transaction history, including closed and resold positions. */
export async function publicActivityRows(connection: Connection, wallet: string): Promise<ActivityRow[]> {
  const program = readOnlyProgramV2(connection);
  const parser = new EventParser(PROGRAM_V2_ID, program.coder);
  const instructionCoder = new BorshInstructionCoder(program.idl);
  const cache = new Map<string, Promise<ArchivedTransaction>>();
  const read = (signature: string) => {
    if (!cache.has(signature)) cache.set(signature, (async () => {
      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (!tx || !tx.meta) throw new Error("Transaction history is unavailable. Use an archival RPC and try again.");
      if (tx.meta.err) return { events: [], instructions: [] };
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
      const feePayer = keys.get(0)?.toBase58() ?? "";
      const events: ChainEvent[] = [];
      for (const ev of parser.parseLogs(tx.meta.logMessages ?? [])) {
        events.push({ slot: tx.slot, signature, blockTime: tx.blockTime ?? 0, fee: tx.meta.fee, feePayer, name: ev.name, data: ev.data as Record<string, unknown>, eventIndex: events.length });
      }
      const instructions: ArchivedInstruction[] = [];
      const all = [...tx.transaction.message.compiledInstructions, ...(tx.meta.innerInstructions ?? []).flatMap((group) => group.instructions)];
      for (const ix of all) {
        if (!keys.get(ix.programIdIndex)?.equals(PROGRAM_V2_ID)) continue;
        if (!tx.meta.logMessages) throw new Error("Program event history is unavailable. Use an archival RPC and try again.");
        const decoded = typeof ix.data === "string" ? instructionCoder.decode(ix.data, "base58") : instructionCoder.decode(Buffer.from(ix.data));
        if (!decoded) continue;
        const definition = program.idl.instructions.find((i) => i.name === decoded.name);
        if (!definition) continue;
        const indexes = "accountKeyIndexes" in ix ? ix.accountKeyIndexes : ix.accounts;
        const accounts: Record<string, string> = {};
        definition.accounts.forEach((account, index) => {
          const address = keys.get(indexes[index]);
          if (address) accounts[camel(account.name)] = address.toBase58();
        });
        instructions.push({ name: camel(decoded.name), accounts, data: decoded.data as Record<string, unknown> });
      }
      return { events, instructions };
    })());
    return cache.get(signature)!;
  };
  const addressCache = new Map<string, Promise<ArchivedTransaction[]>>();
  return replayPublicActivity(wallet, {
    transactionsFor: (address) => {
      if (!addressCache.has(address)) addressCache.set(address, (async () => {
        const signatures = (await allSignatures(connection, new PublicKey(address))).filter((s) => !s.err);
        const transactions: ArchivedTransaction[] = [];
        // Bound RPC concurrency on wallets with substantial history.
        for (let start = 0; start < signatures.length; start += 8) transactions.push(...await Promise.all(signatures.slice(start, start + 8).map((s) => read(s.signature))));
        return transactions;
      })());
      return addressCache.get(address)!;
    },
    blockSignatures: async (slot) => {
      const block = await connection.getBlockSignatures(slot, "confirmed");
      if (!block) throw new Error("Block transaction order is unavailable.");
      return block.signatures;
    },
  });
}
