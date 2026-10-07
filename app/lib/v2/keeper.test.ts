import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { decide, DEFAULT_KEEPER_LIMITS } from "./keeper";
import { EarlyRepayment, graceEnd, openLedger, type TermsV2 } from "../loan-math-v2";
import type { OfferV2 } from "./offers";
import type { PriceSnapshot } from "../offer-status";

const NOW = 1_800_000_000;
const k = () => Keypair.generate().publicKey.toBase58();
const terms: TermsV2 = { principal: 10_000_000n, interestBps: 500, duration: 30 * 86_400, startTs: NOW, earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 2500, graceSeconds: 86_400, lateFeeBps: 100, annualCeilingBps: 10_000 };
const offer = (over: Partial<OfferV2> = {}): OfferV2 => ({
  generation: "v2", publicKey: k(), version: 2, originLender: k(), currentLender: k(), borrower: k(), restrictedBorrower: null, offerId: 1n, usdcMint: "u", wsolMint: "w",
  terms, collateralRequired: 102_000_000n, collateralLocked: 102_000_000n, maxLtvBps: 7000, liquidationLtvBps: 8000, status: "active", ledger: openLedger(terms), shortfall: 0n, settledTs: 0, ...over,
});
const price = (usd: number, fresh = true): PriceSnapshot => ({ price: BigInt(usd * 1e8), conf: 0n, exponent: -8, publishTime: NOW, fresh, ema: { price: BigInt(usd * 1e8), conf: 0n } });
const L = DEFAULT_KEEPER_LIMITS;

test("a healthy running loan is left alone", () => {
  assert.deepEqual(decide(offer(), price(150), NOW + 86_400, L, 0n, 10n ** 12n), { act: false, reason: "healthy" });
});

test("an overdue loan is settled after grace, within limits", () => {
  const d = decide(offer(), price(150), graceEnd(terms), L, 0n, 10n ** 12n);
  assert.equal(d.act, true);
  if (d.act) {
    assert.equal(d.kind, "overdue");
    assert.ok(d.receiveValue > d.payoff);
  }
  assert.deepEqual(decide(offer(), price(150), graceEnd(terms) - 1, L, 0n, 10n ** 12n), { act: false, reason: "healthy" });
});

test("limits and freshness stop the keeper", () => {
  const at = graceEnd(terms);
  assert.deepEqual(decide(offer(), price(150, false), at, L, 0n, 10n ** 12n), { act: false, reason: "stale-price" });
  assert.deepEqual(decide(offer(), price(150), at, { ...L, maxPerAction: 1n }, 0n, 10n ** 12n), { act: false, reason: "over-action-cap" });
  assert.deepEqual(decide(offer(), price(150), at, L, L.totalCapital, 10n ** 12n), { act: false, reason: "over-capital" });
  assert.deepEqual(decide(offer(), price(150), at, L, 0n, 1n), { act: false, reason: "no-funds" });
  // Collateral worth less than the payoff plus the minimum margin: not worth it.
  assert.deepEqual(decide(offer({ collateralLocked: 60_000_000n }), price(150), at, L, 0n, 10n ** 12n), { act: false, reason: "unprofitable" });
  assert.deepEqual(decide(offer({ status: "repaid" }), price(150), at, L, 0n, 10n ** 12n), { act: false, reason: "not-active" });
});

test("risk liquidation follows the spot-and-EMA trigger", () => {
  const d = decide(offer(), price(118), NOW + 86_400, L, 0n, 10n ** 12n);
  assert.equal(d.act, true);
  if (d.act) assert.equal(d.kind, "risk");
});

test("a stale price is only worth refreshing for loans near their line", () => {
  assert.deepEqual(decide(offer(), price(150, false), NOW + 86_400, L, 0n, 10n ** 12n), { act: false, reason: "healthy" });
  assert.deepEqual(decide(offer(), price(126, false), NOW + 86_400, L, 0n, 10n ** 12n), { act: false, reason: "stale-price" });
});

test("signed identity and capital are reserved before send; ambiguous sends stay pending", async () => {
  const { Transaction, SystemProgram } = await import("@solana/web3.js");
  const { sendReservedKeeperTransaction } = await import("./keeper");
  const keeper = Keypair.generate();
  const tx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: k() }).add(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.sign(keeper);
  const events: string[] = [];
  const rpc = {
    sendRawTransaction: async () => { events.push("send"); throw new Error("Connection lost after acceptance"); },
    confirmTransaction: async () => { throw new Error("unused"); },
  } as unknown as Pick<import("@solana/web3.js").Connection, "sendRawTransaction" | "confirmTransaction">;
  const result = await sendReservedKeeperTransaction(rpc, tx, 100, async (signature) => { assert.ok(signature.length > 60); events.push("reserved"); return true; }, async () => { events.push("released"); });
  assert.equal(result?.result, "pending");
  assert.deepEqual(events, ["reserved", "send"]);
  events.length = 0;
  rpc.sendRawTransaction = async () => { events.push("send"); return "accepted"; };
  rpc.confirmTransaction = (async () => { throw new Error("confirmation timeout"); }) as typeof rpc.confirmTransaction;
  assert.equal((await sendReservedKeeperTransaction(rpc, tx, 100, async () => { events.push("reserved"); return true; }, async () => { events.push("released"); }))?.result, "pending");
  assert.deepEqual(events, ["reserved", "send"]);
  events.length = 0;
  assert.equal(await sendReservedKeeperTransaction(rpc, tx, 100, async () => false, async () => {}), null);
  assert.deepEqual(events, []);
  await assert.rejects(sendReservedKeeperTransaction(rpc, tx, 100, async () => { throw new Error("durable store unavailable"); }, async () => {}), /durable store/);
  assert.deepEqual(events, []);
});

test("keeper reconciles confirmed signatures and waits for finalized expiry of absent signatures", async () => {
  const { reconcileKeeperTransactions } = await import("./keeper");
  const outcomes: [string, string][] = [];
  let height = 101;
  const states = new Map([
    ["processed", { confirmationStatus: "processed", err: null }],
    ["processed-error", { confirmationStatus: "processed", err: { InstructionError: [0, "Custom"] } }],
    ["confirmed", { confirmationStatus: "confirmed", err: null }],
    ["failed", { confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }],
  ]);
  const rpc = {
    getSignatureStatuses: async ([signature]: string[]) => ({ value: [states.get(signature) ?? null] }),
    getBlockHeight: async (commitment: string) => { assert.equal(commitment, "finalized"); return height; },
  } as unknown as Pick<import("@solana/web3.js").Connection, "getSignatureStatuses" | "getBlockHeight">;
  const records = ["processed", "processed-error", "confirmed", "failed", "absent"].map((signature) => ({ signature, lastValidBlockHeight: 100, kind: "risk" as const }));
  await reconcileKeeperTransactions(rpc, records, async (sig, result) => { outcomes.push([sig, result]); });
  assert.deepEqual(outcomes, [["confirmed", "settled-risk"], ["failed", "failed-chain"], ["absent", "expired"]]);
  outcomes.length = 0;
  height = 100;
  await reconcileKeeperTransactions(rpc, [records[4]], async (sig, result) => { outcomes.push([sig, result]); });
  assert.deepEqual(outcomes, []);
});

test("durable keeper admission holds pending capital across passes and resolves idempotently", async () => {
  const { reserve, resolve, spentInWindow } = await import("../../convex/keeperData");
  // Exercise the actual mutation/query handlers against an indexed store. Convex serializes
  // atomic admissions in production, so each sees reservations from earlier admissions.
  type Row = { _id: string; at: number; offer: string; result: string; payoff?: string; signature?: string; lastValidBlockHeight?: number };
  const rows: Row[] = [];
  const db = {
    query: () => ({ withIndex: (_name: string, range?: (q: unknown) => unknown) => {
      const predicates: ((row: Row) => boolean)[] = [];
      const q = {
        eq: (field: keyof Row, value: unknown) => { predicates.push((r) => r[field] === value); return q; },
        gte: (field: "at", value: number) => { predicates.push((r) => r[field] >= value); return q; },
      };
      range?.(q);
      const found = () => rows.filter((r) => predicates.every((p) => p(r)));
      return { take: async (n: number) => found().slice(0, n), first: async () => found()[0] ?? null };
    } }),
    insert: async (_table: string, value: Omit<Row, "_id">) => { rows.push({ ...value, _id: String(rows.length) }); },
    patch: async (id: string, value: Partial<Row>) => { Object.assign(rows.find((r) => r._id === id)!, value); },
  };
  type Handler<A, R> = { _handler: (ctx: { db: typeof db }, args: A) => Promise<R> };
  type Reservation = { offer: string; signature: string; payoff: string; kind: "risk"; lastValidBlockHeight: number; maxPerAction: string; totalCapital: string };
  const admit = (reserve as unknown as Handler<Reservation, boolean>)._handler;
  const finish = (resolve as unknown as Handler<{ signature: string; result: string }, null>)._handler;
  const used = () => (spentInWindow as unknown as Handler<object, string>)._handler({ db }, {});
  const a: Reservation = { offer: "loan-a", signature: "a", payoff: "60", kind: "risk", lastValidBlockHeight: 10, maxPerAction: "70", totalCapital: "100" };
  assert.equal(await admit({ db }, a), true);
  rows[0].at = Date.now() - 2 * 86_400_000;
  assert.equal(await used(), "60", "pending reservations never age out of the budget");
  assert.equal(await admit({ db }, { ...a, signature: "same-loan", payoff: "10" }), false);
  assert.equal(await admit({ db }, { ...a, offer: "loan-b", signature: "b" }), false);
  await finish({ db }, { signature: "a", result: "settled-risk" });
  await finish({ db }, { signature: "a", result: "settled-risk" });
  assert.equal(await used(), "60");
  assert.equal(rows.length, 1);
  assert.equal(await admit({ db }, { ...a, offer: "loan-b", signature: "b", payoff: "40" }), true);
  await finish({ db }, { signature: "b", result: "expired" });
  assert.equal(await used(), "60");
  assert.equal(await admit({ db }, { ...a, offer: "loan-b", signature: "c", payoff: "40" }), true);
});
