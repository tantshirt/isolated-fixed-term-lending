/**
 * Public reference liquidator (Story 21.3). It settles V2 loans that the program allows anyone to
 * settle (risk liquidation past the spot-and-EMA line, or overdue after grace) using
 * operator-owned Devnet USDC, within explicit limits. It never uses anyone else's funds and never
 * promises to act: a loan can always be settled by any other caller.
 */
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, Transaction, type Connection, type Keypair } from "@solana/web3.js";
import { collateralValueUsdc } from "../loan-math";
import { graceEnd, liquidationSplit, payoff as payoffAt } from "../loan-math-v2";
import { v2LoanView } from "../models/loan-view";
import type { PriceSnapshot } from "../offer-status";
import { KeypairWallet } from "../keypair-wallet";
import { fetchOfferV2, fetchOffersV2, type OfferV2 } from "./offers";
import { getProgramV2, wsolVaultV2Pda } from "./program";

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
  /** Persist before confirming, so a crash leaves an uncertain record instead of a blind resend. */
  recordSignature: (offer: string, signature: string, lastValidBlockHeight: number) => Promise<void>;
  limits?: KeeperLimits;
  spentInWindow: bigint;
  now: () => number;
};

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
      const signature = await d.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await d.recordSignature(o.publicKey, signature, lastValidBlockHeight);
      const res = await d.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) {
        outcomes.push({ offer: o.publicKey, result: `failed: ${JSON.stringify(res.value.err)}`, signature });
        continue;
      }
      spent += decision.payoff;
      usdc = await balance();
      outcomes.push({ offer: o.publicKey, result: `settled-${decision.kind}`, signature, payoff: decision.payoff.toString() });
    } catch (e) {
      outcomes.push({ offer: o.publicKey, result: `error: ${String(e).slice(0, 200)}` });
    }
  }
  return { scanned: active.length, outcomes, usdcBalance: usdc.toString() };
}
