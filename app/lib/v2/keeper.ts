/**
 * Public reference liquidator (Story 21.3). It settles V2 loans that the program allows anyone to
 * settle (risk liquidation past the spot-and-EMA line, or overdue after grace) using
 * operator-owned Devnet USDC, within explicit limits. It never uses anyone else's funds and never
 * promises to act: a loan can always be settled by any other caller.
 */
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, Transaction, type Connection, type Keypair } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { collateralValueUsdc } from "../loan-math";
import { graceEnd, maturity, liquidationSplit, payoff as payoffAt } from "../loan-math-v2";
import { v2LoanView } from "../models/loan-view";
import type { PriceSnapshot } from "../offer-status";
import { KeypairWallet } from "../keypair-wallet";
import { fetchOfferV2, fetchOffersV2, type OfferV2 } from "./offers";
import { getProgramV2, wsolVaultV2Pda } from "./program";
import { decideMandate, TRIGGER_HEALTH, type Mandate } from "./mandates";

export type KeeperLimits = {
  /** Largest payoff the keeper pays in one action, in USDC atoms. */
  maxPerAction: bigint;
  /** Most USDC the keeper may pay across actions in the rolling window, in atoms. */
  totalCapital: bigint;
  /** Required margin of collateral value received over USDC paid, in bps of the payoff. */
  minPayoutBps: number;
};

/** How close to the line, in LTV bps, a loan must be before a stale price is refreshed for it. */
const NEAR_LINE_BPS = 500;

export const DEFAULT_KEEPER_LIMITS: KeeperLimits = { maxPerAction: 50_000_000n, totalCapital: 200_000_000n, minPayoutBps: 100 };

export type Decision =
  | { act: true; kind: "risk" | "overdue"; payoff: bigint; receive: bigint; receiveValue: bigint }
  | { act: false; reason: "healthy" | "not-due" | "stale-price" | "over-action-cap" | "over-capital" | "unprofitable" | "no-funds" | "not-active" };

/** Pure: should the keeper settle this loan now, within its limits? */
export function decide(o: OfferV2, price: PriceSnapshot | null, now: number, limits: KeeperLimits, spentInWindow: bigint, usdcBalance: bigint): Decision {
  if (o.status !== "active") return { act: false, reason: "not-active" };
  const overdue = now >= graceEnd(o.terms);
  const view = v2LoanView(o, price, now);
  if (!overdue && !view.risk?.liquidatable) {
    if (!view.risk) return { act: false, reason: "not-due" };
    // A stale price is only worth refreshing when the loan is near its line.
    const near = view.risk.ltvBps + NEAR_LINE_BPS >= o.liquidationLtvBps;
    return { act: false, reason: !price?.fresh && near ? "stale-price" : "healthy" };
  }
  if (!price?.fresh) return { act: false, reason: "stale-price" };
  const owed = payoffAt(o.terms, o.ledger, now);
  if (owed > limits.maxPerAction) return { act: false, reason: "over-action-cap" };
  if (spentInWindow + owed > limits.totalCapital) return { act: false, reason: "over-capital" };
  if (owed > usdcBalance) return { act: false, reason: "no-funds" };
  const value = collateralValueUsdc(o.collateralLocked, price.price, price.conf, price.exponent);
  if (value === 0n) return { act: false, reason: "unprofitable" };
  const split = liquidationSplit(owed, o.collateralLocked, value);
  const receiveValue = collateralValueUsdc(split.toRecipient, price.price, price.conf, price.exponent);
  if (receiveValue * 10_000n < owed * BigInt(10_000 + limits.minPayoutBps)) return { act: false, reason: "unprofitable" };
  return { act: true, kind: overdue ? "overdue" : "risk", payoff: owed, receive: split.toRecipient, receiveValue };
}

export type KeeperDeps = {
  connection: Connection;
  keeper: Keypair;
  priceAccount: PublicKey;
  readPrice: () => Promise<PriceSnapshot | null>;
  /** Posts a fresh Pyth update when a candidate needs one. */
  postPrice: () => Promise<void>;
  /** Atomically reserve capital and persist the signed identity BEFORE any network send. */
  recordSignature: (offer: string, signature: string, lastValidBlockHeight: number, payoff: string, kind: "risk" | "overdue") => Promise<boolean>;
  recordOutcome: (signature: string, result: string) => Promise<void>;
  limits?: KeeperLimits;
  spentInWindow: bigint;
  now: () => number;
};

export type PendingKeeperTransaction = { signature: string; lastValidBlockHeight: number; kind: "risk" | "overdue" };

/** A processed signature can still land. Only finalized expiry proves an absent one cannot. */
export async function reconcileKeeperTransactions(
  connection: Pick<Connection, "getSignatureStatuses" | "getBlockHeight">,
  pending: PendingKeeperTransaction[],
  recordOutcome: KeeperDeps["recordOutcome"],
): Promise<void> {
  for (const p of pending) {
    const status = (await connection.getSignatureStatuses([p.signature], { searchTransactionHistory: true })).value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      await recordOutcome(p.signature, status.err ? "failed-chain" : `settled-${p.kind}`);
    } else if (!status && await connection.getBlockHeight("finalized") > p.lastValidBlockHeight) {
      await recordOutcome(p.signature, "expired");
    }
  }
}

/** Signed bytes are safe to send only after their durable reservation succeeds. */
export async function sendReservedKeeperTransaction(
  connection: Pick<Connection, "sendRawTransaction" | "confirmTransaction">,
  tx: Transaction,
  lastValidBlockHeight: number,
  reserve: (signature: string) => Promise<boolean>,
  recordOutcome: KeeperDeps["recordOutcome"],
): Promise<{ signature: string; result: "confirmed" | "failed-chain" | "pending" } | null> {
  if (!tx.signature || !tx.recentBlockhash) throw new Error("Keeper transaction must be signed before reservation.");
  const bytes = tx.serialize();
  const signature = utils.bytes.bs58.encode(tx.signature);
  if (!await reserve(signature)) return null;
  try {
    await connection.sendRawTransaction(bytes, { skipPreflight: true });
    const res = await connection.confirmTransaction({ signature, blockhash: tx.recentBlockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) {
      await recordOutcome(signature, "failed-chain");
      return { signature, result: "failed-chain" };
    }
    return { signature, result: "confirmed" };
  } catch {
    // Neither a send error nor a confirmation timeout proves the transaction failed.
    return { signature, result: "pending" };
  }
}

/** One pass: find candidates, re-check each from fresh state, simulate, send, confirm. */
export async function runKeeperOnce(d: KeeperDeps): Promise<{ scanned: number; outcomes: { offer: string; result: string; signature?: string; payoff?: string }[]; usdcBalance: string }> {
  const limits = d.limits ?? DEFAULT_KEEPER_LIMITS;
  const usdcMint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  const keeperUsdc = getAssociatedTokenAddressSync(usdcMint, d.keeper.publicKey);
  const balance = async () => BigInt((await d.connection.getTokenAccountBalance(keeperUsdc).catch(() => ({ value: { amount: "0" } }))).value.amount);
  let usdc = await balance();
  let spent = d.spentInWindow;
  const active = (await fetchOffersV2(d.connection)).filter((o) => o.status === "active");
  const outcomes: { offer: string; result: string; signature?: string; payoff?: string }[] = [];
  let price = await d.readPrice();
  for (const listed of active) {
    let first = decide(listed, price, d.now(), limits, spent, usdc);
    if (!first.act && first.reason === "stale-price") {
      try {
        await d.postPrice();
        price = await d.readPrice();
      } catch (e) {
        outcomes.push({ offer: listed.publicKey, result: `price-post-failed: ${String(e).slice(0, 120)}` });
        continue;
      }
      first = decide(listed, price, d.now(), limits, spent, usdc);
    }
    if (!first.act) {
      if (first.reason !== "healthy" && first.reason !== "not-due") outcomes.push({ offer: listed.publicKey, result: first.reason });
      continue;
    }
    // Fresh review: the loan may have been repaid or topped up since the scan.
    const o = await fetchOfferV2(d.connection, new PublicKey(listed.publicKey));
    const decision = o ? decide(o, price, d.now(), limits, spent, usdc) : ({ act: false, reason: "not-active" } as const);
    if (!o || !decision.act) {
      outcomes.push({ offer: listed.publicKey, result: decision.act ? "changed" : decision.reason });
      continue;
    }
    try {
      const signer = new KeypairWallet(d.keeper);
      const program = getProgramV2(signer, d.connection);
      const offer = new PublicKey(o.publicKey);
      const ata = (mint: string, owner: string) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true);
      const builder = decision.kind === "overdue" ? program.methods.liquidateOverdue() : program.methods.liquidate();
      const ix = await builder
        .accountsPartial({
          caller: d.keeper.publicKey, offer, priceUpdate: d.priceAccount, wsolVault: wsolVaultV2Pda(offer), callerUsdc: keeperUsdc, callerWsol: ata(o.wsolMint, d.keeper.publicKey.toBase58()),
          lender: new PublicKey(o.currentLender), lenderUsdc: ata(o.usdcMint, o.currentLender), borrower: new PublicKey(o.borrower!), borrowerWsol: ata(o.wsolMint, o.borrower!), tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      const ensure = (owner: string, mint: string) => createAssociatedTokenAccountIdempotentInstruction(d.keeper.publicKey, ata(mint, owner), new PublicKey(owner), new PublicKey(mint), TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const { blockhash, lastValidBlockHeight } = await d.connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: d.keeper.publicKey, blockhash, lastValidBlockHeight }).add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
        ensure(d.keeper.publicKey.toBase58(), o.wsolMint),
        ensure(o.currentLender, o.usdcMint),
        ensure(o.borrower!, o.wsolMint),
        ix,
      );
      tx.sign(d.keeper);
      const sim = await d.connection.simulateTransaction(tx);
      if (sim.value.err) {
        outcomes.push({ offer: o.publicKey, result: `simulation refused: ${JSON.stringify(sim.value.err)}` });
        continue;
      }
      // Reserve the largest remaining payoff, including maturity's fee: accrual while the
      // signed transaction is in flight must never exceed either capital limit.
      const reservedPayoff = payoffAt(o.terms, o.ledger, Math.max(d.now(), maturity(o.terms)));
      if (reservedPayoff > limits.maxPerAction || spent + reservedPayoff > limits.totalCapital || reservedPayoff > usdc) {
        outcomes.push({ offer: o.publicKey, result: reservedPayoff > limits.maxPerAction ? "over-action-cap" : reservedPayoff > usdc ? "no-funds" : "over-capital" });
        continue;
      }
      const sent = await sendReservedKeeperTransaction(d.connection, tx, lastValidBlockHeight, async (signature) => {
        const reserved = await d.recordSignature(o.publicKey, signature, lastValidBlockHeight, reservedPayoff.toString(), decision.kind);
        if (reserved) { spent += reservedPayoff; usdc -= reservedPayoff; }
        return reserved;
      }, d.recordOutcome);
      if (!sent) {
        outcomes.push({ offer: o.publicKey, result: "over-capital" });
        continue;
      }
      if (sent.result !== "confirmed") {
        outcomes.push({ offer: o.publicKey, result: sent.result, signature: sent.signature });
        continue;
      }
      await d.recordOutcome(sent.signature, `settled-${decision.kind}`);
      usdc = await balance();
      outcomes.push({ offer: o.publicKey, result: `settled-${decision.kind}`, signature: sent.signature, payoff: reservedPayoff.toString() });
    } catch (e) {
      outcomes.push({ offer: o.publicKey, result: `error: ${String(e).slice(0, 200)}` });
    }
  }
  return { scanned: active.length, outcomes, usdcBalance: usdc.toString() };
}

// ---- Story 26.3: automation mandates (public loans only) ----------------------------------

/** A mandate job that retrying cannot help: bad payload, private loan, or the feature is off. */
export class MandateJobRefused extends Error {}

export type MandateJobPayload = { mandate: string; private?: boolean };

export type MandateJobDeps = {
  /** `MANDATES_ENABLED` and a keeper key on this deployment. */
  enabled: boolean;
  loadMandate: (key: string) => Promise<Mandate | null>;
  loadOffer: (key: string) => Promise<OfferV2 | null>;
  /** The loan's collateral price; SOL/USD for wSOL, null when this reader has no feed for it. */
  readPrice: (o: OfferV2) => Promise<PriceSnapshot | null>;
  /** Builds and signs `execute_mandate` for `fee`. Signing happens before any send. */
  sign: (m: Mandate, o: OfferV2, fee: bigint) => Promise<{ tx: Transaction; lastValidBlockHeight: number }>;
  simulate: (tx: Transaction) => Promise<unknown | null>;
  /** The job queue's durable signature record: called before the network send. */
  recordSignature: (signature: string, lastValidBlockHeight: number) => Promise<void>;
  send: (tx: Transaction, lastValidBlockHeight: number) => Promise<"confirmed" | "failed-chain">;
  now: () => number;
};

/**
 * One `mandate-execute` job. It re-reads the mandate and loan, decides exactly as the program
 * will, simulates, records the signature with the job (so the queue reconciles instead of
 * resending), then sends. The keeper pays nothing here: the program moves only the borrower's
 * delegated allowance, into this loan or to its lender, plus the bounded fee. It is never
 * liquidation capital.
 */
export async function runMandateJob(payload: unknown, d: MandateJobDeps): Promise<{ result: string; signature?: string }> {
  if (!d.enabled) throw new MandateJobRefused("Mandates are not enabled on this deployment.");
  const p = payload as Partial<MandateJobPayload> | null;
  // Private mandates run in the rollup crank, never in Convex.
  if (p?.private) throw new MandateJobRefused("Private mandates are evaluated in the rollup, not here.");
  let key: string;
  try {
    key = new PublicKey(p?.mandate ?? "").toBase58();
  } catch {
    throw new MandateJobRefused("The job names no mandate.");
  }
  const m = await d.loadMandate(key);
  if (!m) return { result: "no-mandate" };
  const o = await d.loadOffer(m.offer);
  if (!o) return { result: "no-loan" };
  const price = m.trigger === TRIGGER_HEALTH ? await d.readPrice(o) : null;
  const decision = decideMandate(m, o, price, d.now());
  // A non-wSOL health trigger is decided by simulation, which reads the asset's own feed.
  const simulateOnly = !decision.due && decision.reason === "needs-asset-price";
  if (!decision.due && !simulateOnly) return { result: decision.reason };
  const room = m.feeCap - m.feesPaid;
  const fee = decision.due ? decision.plan.fee : m.feePerExec < room ? m.feePerExec : room;
  const { tx, lastValidBlockHeight } = await d.sign(m, o, fee);
  const err = await d.simulate(tx);
  if (err) return { result: `simulation refused: ${JSON.stringify(err).slice(0, 160)}` };
  if (!tx.signature) throw new Error("Mandate transaction must be signed before it is recorded.");
  const signature = utils.bytes.bs58.encode(tx.signature);
  await d.recordSignature(signature, lastValidBlockHeight);
  const result = await d.send(tx, lastValidBlockHeight);
  if (result === "failed-chain") throw new Error("execute_mandate failed on chain");
  return { result: "executed", signature };
}
