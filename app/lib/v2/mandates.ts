/**
 * Automation mandates (Story 26.3, research.md § Automation mandates). A borrower pre-authorizes
 * one bounded top-up or repay per loan and action; only `Config.authorities.keeper` executes it,
 * and every bound is checked on-chain. This file mirrors `loan_core::mandate` so the interface
 * and the keeper make the same decision the program will. Public loans only: private mandates
 * are evaluated by their crank inside the rollup, never here and never in Convex.
 */
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import type { BN } from "@coral-xyz/anchor";
import { NATIVE_WSOL_MINT, PYTH_PRICE_UPDATE_ACCOUNT } from "../constants";
import { currentLtvBps } from "../loan-math";
import { maturity, payoff as payoffAt } from "../loan-math-v2";
import { asSigner, type LoanSigner } from "../keypair-wallet";
import { bnU64, getConnection } from "../program";
import { submitTransaction } from "../transaction-lifecycle";
import type { PriceSnapshot } from "../offer-status";
import type { OfferV2 } from "./offers";
import { collateralValueAtoms } from "../models/collateral";
import { feedPriceAccount } from "./collateral-accounts";
import { PROGRAM_V2_ID, collateralConfigV2Pda, getProgramV2, v2Coder, wsolVaultV2Pda } from "./program";

/** Off until the deployment's `isolated_loan_v2` carries the mandate instructions. */
export const MANDATES_ENABLED = process.env.NEXT_PUBLIC_MANDATES_ENABLED === "1";

export const ACTION_TOP_UP = 0;
export const ACTION_REPAY = 1;
export const TRIGGER_HEALTH = 0;
export const TRIGGER_TIME = 1;
/** A fired health trigger re-arms only once LTV is this far below it. */
export const REARM_GAP_BPS = 200;

export type MandateAction = typeof ACTION_TOP_UP | typeof ACTION_REPAY;

export type MandateBounds = {
  action: MandateAction;
  trigger: typeof TRIGGER_HEALTH | typeof TRIGGER_TIME;
  triggerLtvBps: number;
  leadSeconds: number;
  amountPerExec: bigint;
  /** Everything drawn from the allowance: amounts plus fees. */
  cumulativeCap: bigint;
  feePerExec: bigint;
  feeCap: bigint;
  expiry: number;
};

export type Mandate = MandateBounds & {
  publicKey: string;
  borrower: string;
  offer: string;
  source: string;
  used: bigint;
  feesPaid: bigint;
  armed: boolean;
  executions: number;
  lastExecTs: number;
};

const MANDATE_SEED = Buffer.from("mandate");
export const mandatePda = (offer: PublicKey, action: MandateAction) => PublicKey.findProgramAddressSync([MANDATE_SEED, offer.toBuffer(), Buffer.from([action])], PROGRAM_V2_ID)[0];

/** Why these bounds cannot be signed for this loan, or null. Same rule as the program. */
export function validateBounds(b: MandateBounds, now: number, liquidationLtvBps: number, duration: number): string | null {
  if (b.action !== ACTION_TOP_UP && b.action !== ACTION_REPAY) return "Choose top-up or repay.";
  if (b.trigger === TRIGGER_HEALTH) {
    if (b.triggerLtvBps <= REARM_GAP_BPS || b.triggerLtvBps >= liquidationLtvBps) return "The trigger must sit below this loan's liquidation line.";
    if (b.leadSeconds !== 0) return "A health trigger has no lead time.";
  } else if (b.trigger === TRIGGER_TIME) {
    if (b.leadSeconds <= 0 || b.leadSeconds > duration) return "The lead time must be within the loan's term.";
    if (b.triggerLtvBps !== 0) return "A time trigger has no LTV.";
  } else return "Choose a trigger.";
  if (b.amountPerExec <= 0n || b.cumulativeCap <= 0n) return "Amounts must be above zero.";
  if (b.feeCap > b.cumulativeCap) return "The fee cap cannot exceed the total cap.";
  if (b.feePerExec > b.feeCap) return "The fee per execution cannot exceed the fee cap.";
  if (b.expiry <= now) return "The expiry must be in the future.";
  return null;
}

export type MandatePlan = { amount: bigint; fee: bigint };

/** The fixed amount clamped to what the cap leaves after the fee and, for a repay, to the payoff. */
export function planMandate(m: Pick<Mandate, "amountPerExec" | "cumulativeCap" | "used" | "feesPaid" | "feePerExec" | "feeCap">, fee: bigint, payoff: bigint | null): MandatePlan | "fee-above-cap" | "cap-reached" {
  if (fee > m.feePerExec || m.feesPaid + fee > m.feeCap) return "fee-above-cap";
  let left = m.cumulativeCap - m.used - fee;
  if (left < 0n) left = 0n;
  let amount = m.amountPerExec < left ? m.amountPerExec : left;
  if (payoff !== null && payoff < amount) amount = payoff;
  return amount === 0n ? "cap-reached" : { amount, fee };
}

export type MandatePrice = PriceSnapshot & { collateralDecimals?: number };
export type MandateOperation = "execute" | "rearm";

export type MandateDecision =
  | { due: true; plan: MandatePlan; ltvBps: number | null }
  | { due: false; reason: "not-active" | "expired" | "not-armed" | "not-triggered" | "stale-price" | "cap-reached" | "fee-above-cap" | "needs-asset-price" };

/**
 * Pure: would `execute_mandate` succeed now with the largest fee the bounds allow? `price` is the
 * loan's collateral price (SOL/USD for wSOL). A non-wSOL health trigger without its own price
 * returns `needs-asset-price` and cannot execute until the keeper reads a fresh asset price.
 */
export function decideMandate(m: Mandate, o: OfferV2, price: MandatePrice | null, now: number): MandateDecision {
  if (o.status !== "active") return { due: false, reason: "not-active" };
  if (now >= m.expiry) return { due: false, reason: "expired" };
  if (!m.armed) return { due: false, reason: "not-armed" };
  const owed = payoffAt(o.terms, o.ledger, now);
  let ltvBps: number | null = null;
  if (m.trigger === TRIGGER_HEALTH) {
    if (o.wsolMint !== NATIVE_WSOL_MINT.toBase58() && !price) return { due: false, reason: "needs-asset-price" };
    if (!price?.fresh) return { due: false, reason: "stale-price" };
    ltvBps = currentLtvBps(owed, collateralValueAtoms(o.collateralLocked, price.collateralDecimals ?? 9, price.price, price.conf, price.exponent));
    if (ltvBps < m.triggerLtvBps) return { due: false, reason: "not-triggered" };
  } else if (now < maturity(o.terms) - m.leadSeconds) return { due: false, reason: "not-triggered" };
  const remainingFeeRoom = m.feeCap - m.feesPaid;
  const fee = m.feePerExec < remainingFeeRoom ? m.feePerExec : remainingFeeRoom;
  const plan = planMandate(m, fee < 0n ? 0n : fee, m.action === ACTION_REPAY ? owed : null);
  if (typeof plan === "string") return { due: false, reason: plan };
  return { due: true, plan, ltvBps };
}

/** Rearming is a separate durable job; it never spends allowance or charges a fee. */
export function decideRearm(m: Mandate, o: OfferV2, price: MandatePrice | null, now: number): { due: boolean; reason: string } {
  if (o.status !== "active") return { due: false, reason: "not-active" };
  if (now >= m.expiry) return { due: false, reason: "expired" };
  if (m.armed || m.trigger !== TRIGGER_HEALTH) return { due: false, reason: "not-rearmable" };
  if (!price?.fresh) return { due: false, reason: "stale-price" };
  const value = collateralValueAtoms(o.collateralLocked, price.collateralDecimals ?? 9, price.price, price.conf, price.exponent);
  const ltv = currentLtvBps(payoffAt(o.terms, o.ledger, now), value);
  return ltv <= m.triggerLtvBps - REARM_GAP_BPS ? { due: true, reason: "rearm" } : { due: false, reason: "not-recovered" };
}

type RawMandate = {
  borrower: PublicKey; offer: PublicKey; action: number; source: PublicKey; trigger: number; triggerLtvBps: number; leadSeconds: BN;
  amountPerExec: BN; cumulativeCap: BN; used: BN; feePerExec: BN; feeCap: BN; feesPaid: BN; expiry: BN; armed: boolean; executions: number; lastExecTs: BN;
};
const big = (v: BN) => BigInt(v.toString());
const num = (v: BN) => Number(v.toString());

export function decodeMandate(publicKey: PublicKey, data: Buffer): Mandate {
  const a = v2Coder.decode("mandate", data) as RawMandate;
  return {
    publicKey: publicKey.toBase58(),
    borrower: a.borrower.toBase58(),
    offer: a.offer.toBase58(),
    action: a.action as MandateAction,
    source: a.source.toBase58(),
    trigger: a.trigger as MandateBounds["trigger"],
    triggerLtvBps: a.triggerLtvBps,
    leadSeconds: num(a.leadSeconds),
    amountPerExec: big(a.amountPerExec),
    cumulativeCap: big(a.cumulativeCap),
    used: big(a.used),
    feePerExec: big(a.feePerExec),
    feeCap: big(a.feeCap),
    feesPaid: big(a.feesPaid),
    expiry: num(a.expiry),
    armed: a.armed,
    executions: a.executions,
    lastExecTs: num(a.lastExecTs),
  };
}

export async function fetchMandate(connection: Connection, offer: PublicKey, action: MandateAction): Promise<Mandate | null> {
  const key = mandatePda(offer, action);
  const info = await connection.getAccountInfo(key);
  return info ? decodeMandate(key, info.data as Buffer) : null;
}

/** Every live mandate, for the keeper scan. */
export async function fetchMandates(connection: Connection): Promise<Mandate[]> {
  const rows = await connection.getProgramAccounts(PROGRAM_V2_ID, { filters: [{ memcmp: v2Coder.memcmp("mandate") }] });
  return rows.map((r) => decodeMandate(r.pubkey, r.account.data as Buffer));
}

const ata = (mint: PublicKey | string, owner: PublicKey | string) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true);
const sourceMint = (o: OfferV2, action: MandateAction) => (action === ACTION_TOP_UP ? o.wsolMint : o.usdcMint);
const collateralRemaining = (o: OfferV2) =>
  o.wsolMint === NATIVE_WSOL_MINT.toBase58() ? [] : [{ pubkey: collateralConfigV2Pda(new PublicKey(o.wsolMint)), isSigner: false, isWritable: false }];

/** Borrower: creates the mandate and approves its PDA for exactly `cumulativeCap`, fees included. */
export async function sendCreateMandateV2(signerLike: Keypair | LoanSigner, o: OfferV2, b: MandateBounds, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const borrower = signer.publicKey;
  const offer = new PublicKey(o.publicKey);
  const tx = await getProgramV2(signer, connection)
    .methods.createMandate({
      action: b.action, trigger: b.trigger, triggerLtvBps: b.triggerLtvBps, leadSeconds: bnU64(b.leadSeconds), amountPerExec: bnU64(b.amountPerExec),
      cumulativeCap: bnU64(b.cumulativeCap), feePerExec: bnU64(b.feePerExec), feeCap: bnU64(b.feeCap), expiry: bnU64(b.expiry),
    })
    .accountsPartial({ borrower, offer, mandate: mandatePda(offer, b.action), source: ata(sourceMint(o, b.action), borrower), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .transaction();
  return submitTransaction(connection, signer, tx);
}

/** Borrower: closes the mandate and revokes its token delegate. Works after settlement too. */
export async function sendRevokeMandateV2(signerLike: Keypair | LoanSigner, m: Mandate, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const tx = await getProgramV2(signer, connection)
    .methods.revokeMandate()
    .accountsPartial({ borrower: signer.publicKey, mandate: new PublicKey(m.publicKey), source: new PublicKey(m.source), tokenProgram: TOKEN_PROGRAM_ID })
    .transaction();
  return submitTransaction(connection, signer, tx);
}

/** Seconds per dedup window: at most one queued job per mandate, execution count and window. */
export const MANDATE_JOB_WINDOW_SECONDS = 300;

/**
 * Pure: the `mandate-execute` jobs a scan should enqueue. The dedup key moves with each
 * execution and each window, so a job that found nothing to do never blocks a later one, and two
 * scans in one window never queue the same work twice.
 */
export function mandateJobsDue(mandates: Mandate[], offers: Map<string, OfferV2>, price: PriceSnapshot | null, now: number): { dedupKey: string; payload: { mandate: string; operation: MandateOperation } }[] {
  const window = Math.floor(now / MANDATE_JOB_WINDOW_SECONDS);
  const jobs: { dedupKey: string; payload: { mandate: string; operation: MandateOperation } }[] = [];
  for (const m of mandates) {
    const o = offers.get(m.offer);
    if (!o) continue;
    const isWsol = o.wsolMint === NATIVE_WSOL_MINT.toBase58();
    const operation = !m.armed && m.trigger === TRIGGER_HEALTH ? "rearm" : "execute";
    const d = operation === "rearm" ? decideRearm(m, o, isWsol ? price : null, now) : decideMandate(m, o, isWsol ? price : null, now);
    // Missing or stale prices are re-read by the job using this asset's configured feed.
    if (d.due || d.reason === "needs-asset-price" || d.reason === "stale-price") jobs.push({ dedupKey: `mandate:${m.publicKey}:${operation}:${m.executions}:${window}`, payload: { mandate: m.publicKey, operation } });
  }
  return jobs;
}

/** Keeper: the `execute_mandate` instruction for `fee`. */
export async function executeMandateIx(keeper: Keypair, connection: Connection, m: Mandate, o: OfferV2, fee: bigint, priceUpdate = PYTH_PRICE_UPDATE_ACCOUNT): Promise<TransactionInstruction> {
  const offer = new PublicKey(o.publicKey);
  const repay = m.action === ACTION_REPAY;
  // Repay-only accounts are Anchor optional accounts: null encodes "absent" for a top-up.
  const repayOnly = {
    lenderUsdc: repay ? ata(o.usdcMint, o.currentLender) : null,
    borrower: repay ? new PublicKey(o.borrower!) : null,
    borrowerWsol: repay ? ata(o.wsolMint, o.borrower!) : null,
  } as unknown as Record<string, PublicKey>;
  return getProgramV2(keeper, connection)
    .methods.executeMandate(bnU64(fee))
    .accountsPartial({
      keeper: keeper.publicKey, offer, mandate: new PublicKey(m.publicKey), source: new PublicKey(m.source), keeperToken: ata(sourceMint(o, m.action), keeper.publicKey),
      wsolVault: wsolVaultV2Pda(offer), priceUpdate, ...repayOnly, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(collateralRemaining(o))
    .instruction();
}

/** Resolve the actual governance feed, including disabled assets still being serviced. */
export async function mandateCollateral(connection: Connection, o: OfferV2): Promise<{ priceAccount: PublicKey; decimals: number; feedId?: Buffer }> {
  if (o.wsolMint === NATIVE_WSOL_MINT.toBase58()) return { priceAccount: PYTH_PRICE_UPDATE_ACCOUNT, decimals: 9 };
  const info = await connection.getAccountInfo(collateralConfigV2Pda(new PublicKey(o.wsolMint)));
  if (!info || !info.owner.equals(PROGRAM_V2_ID)) throw new Error("Mandate collateral configuration is unavailable.");
  const c = v2Coder.decode("collateralConfig", info.data) as { mint: PublicKey; decimals: number; feedId: number[] };
  if (!c.mint.equals(new PublicKey(o.wsolMint))) throw new Error("Mandate collateral configuration has the wrong mint.");
  const feedId = Buffer.from(c.feedId);
  return { priceAccount: feedPriceAccount(feedId.toString("hex")), decimals: c.decimals, feedId };
}

/** Accounts required even when the fee is zero or a payment will only partially repay. */
export function mandateTokenPreparation(keeper: PublicKey, m: Mandate, o: OfferV2): TransactionInstruction[] {
  const pairs = [[keeper, new PublicKey(sourceMint(o, m.action))]];
  if (m.action === ACTION_REPAY) pairs.push([new PublicKey(o.currentLender), new PublicKey(o.usdcMint)], [new PublicKey(o.borrower!), new PublicKey(o.wsolMint)]);
  return pairs.map(([owner, mint]) => createAssociatedTokenAccountIdempotentInstruction(keeper, ata(mint, owner), owner, mint));
}

export async function rearmMandateIx(keeper: Keypair, connection: Connection, m: Mandate, o: OfferV2, priceUpdate: PublicKey): Promise<TransactionInstruction> {
  const offer = new PublicKey(o.publicKey);
  return getProgramV2(keeper, connection).methods.rearmMandate().accountsPartial({ signer: keeper.publicKey, offer, mandate: new PublicKey(m.publicKey), wsolVault: wsolVaultV2Pda(offer), priceUpdate }).remainingAccounts(collateralRemaining(o)).instruction();
}
