import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction } from "@solana/web3.js";
import { EarlyRepayment, maturity, openLedger, payoff, type TermsV2 } from "../loan-math-v2";
import { loanActionAllowed, ORIGINATING } from "../ops-flags";
import { capabilityFor, DEVNET_USDC } from "../capabilities";
import type { PriceSnapshot } from "../offer-status";
import { MandateJobRefused, runMandateJob, type MandateJobDeps } from "../v2/keeper";
import { ACTION_REPAY, ACTION_TOP_UP, mandateJobsDue, MANDATE_JOB_WINDOW_SECONDS, TRIGGER_HEALTH, TRIGGER_TIME, type Mandate } from "../v2/mandates";
import type { OfferV2 } from "../v2/offers";
import { NATIVE_WSOL_MINT } from "../constants";

const NOW = 1_800_000_000;
const k = () => Keypair.generate().publicKey.toBase58();
const terms: TermsV2 = { principal: 100_000_000n, interestBps: 500, duration: 30 * 86_400, startTs: NOW, earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 2500, graceSeconds: 86_400, lateFeeBps: 100, annualCeilingBps: 10_000 };
const offer = (over: Partial<OfferV2> = {}): OfferV2 => ({
  generation: "v2", publicKey: k(), version: 2, originLender: k(), currentLender: k(), borrower: k(), restrictedBorrower: null, offerId: 1n, usdcMint: k(), wsolMint: NATIVE_WSOL_MINT.toBase58(),
  terms, collateralRequired: 1_020_000_000n, collateralLocked: 1_020_000_000n, maxLtvBps: 7000, liquidationLtvBps: 8000, status: "active", ledger: openLedger(terms), shortfall: 0n, settledTs: 0, ...over,
});
const mandate = (o: OfferV2, over: Partial<Mandate> = {}): Mandate => ({
  publicKey: k(), borrower: o.borrower!, offer: o.publicKey, source: k(), action: ACTION_TOP_UP, trigger: TRIGGER_HEALTH, triggerLtvBps: 7000, leadSeconds: 0,
  amountPerExec: 10_000_000n, cumulativeCap: 25_000_000n, used: 0n, feePerExec: 1_000_000n, feeCap: 2_000_000n, feesPaid: 0n, expiry: NOW + 10 * 86_400, armed: true, executions: 0, lastExecTs: 0, ...over,
});
const price = (usd: number, fresh = true): PriceSnapshot => ({ price: BigInt(usd * 1e8), conf: 0n, exponent: -8, publishTime: NOW, fresh });

/** A fake chain: records the order of calls so the test can prove record-before-send. */
function deps(m: Mandate | null, o: OfferV2 | null, p: PriceSnapshot | null, now: number, over: Partial<MandateJobDeps> = {}) {
  const calls: string[] = [];
  const signed: { fee?: bigint } = {};
  const d: MandateJobDeps = {
    enabled: true,
    loadMandate: async () => m,
    loadOffer: async () => o,
    readPrice: async () => p,
    sign: async (_m, _o, fee) => {
      calls.push("sign");
      signed.fee = fee;
      const payer = Keypair.generate();
      const tx = new Transaction({ feePayer: payer.publicKey, blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 99 });
      tx.add({ keys: [], programId: payer.publicKey, data: Buffer.alloc(0) });
      tx.sign(payer);
      return { tx, lastValidBlockHeight: 99 };
    },
    simulate: async () => {
      calls.push("simulate");
      return null;
    },
    recordSignature: async () => {
      calls.push("record");
    },
    send: async () => {
      calls.push("send");
      return "confirmed";
    },
    now: () => now,
    ...over,
  };
  return { d, calls, signed };
}

test("mandate-execute refuses private loans, bad payloads and a disabled deployment permanently", async () => {
  const o = offer();
  const m = mandate(o);
  await assert.rejects(runMandateJob({ mandate: m.publicKey, private: true }, deps(m, o, price(100), NOW).d), MandateJobRefused);
  await assert.rejects(runMandateJob({ mandate: "not a key" }, deps(m, o, price(100), NOW).d), MandateJobRefused);
  await assert.rejects(runMandateJob({ mandate: m.publicKey }, deps(m, o, price(100), NOW, { enabled: false }).d), MandateJobRefused);
});

test("a due top-up is simulated, recorded with the job, then sent with the bounded fee", async () => {
  const o = offer();
  const m = mandate(o);
  // ~73.5% at 135: above the 70% trigger.
  const { d, calls, signed } = deps(m, o, price(135), NOW + 86_400);
  const r = await runMandateJob({ mandate: m.publicKey }, d);
  assert.equal(r.result, "executed");
  assert.ok(r.signature);
  assert.deepEqual(calls, ["sign", "simulate", "record", "send"], "the signature is durable before any send");
  assert.equal(signed.fee, 1_000_000n);
});

test("nothing is sent when the trigger is not met, the mandate fired, expired, or the loan settled", async () => {
  const o = offer();
  for (const [m, oo, p, now, reason] of [
    [mandate(o), o, price(150), NOW + 86_400, "not-triggered"],
    [mandate(o, { armed: false }), o, price(120), NOW + 86_400, "not-armed"],
    [mandate(o), o, price(120), NOW + 10 * 86_400, "expired"],
    [mandate(o), offer({ status: "repaid" }), price(120), NOW + 86_400, "not-active"],
    [mandate(o), o, price(120, false), NOW + 86_400, "stale-price"],
    [mandate(o, { used: 25_000_000n, feesPaid: 0n }), o, price(120), NOW + 86_400, "cap-reached"],
  ] as const) {
    const { d, calls } = deps(m, oo, p, now);
    assert.deepEqual(await runMandateJob({ mandate: m.publicKey }, d), { result: reason });
    assert.deepEqual(calls, [], reason);
  }
});

test("a refused simulation is reported, never recorded or sent", async () => {
  const o = offer();
  const m = mandate(o);
  const { d, calls } = deps(m, o, price(120), NOW + 86_400, { simulate: async () => ({ InstructionError: [0, { Custom: 6038 }] }) });
  const r = await runMandateJob({ mandate: m.publicKey }, d);
  assert.match(r.result, /simulation refused/);
  assert.deepEqual(calls, ["sign"]);
});

test("a chain failure after the signature is recorded throws, so the queue reconciles", async () => {
  const o = offer();
  const m = mandate(o, { action: ACTION_REPAY, trigger: TRIGGER_TIME, triggerLtvBps: 0, leadSeconds: 86_400, amountPerExec: 500_000_000n, cumulativeCap: 600_000_000n, expiry: NOW + 60 * 86_400 });
  const { d, calls } = deps(m, o, null, maturity(terms) - 86_400, { send: async () => "failed-chain" });
  await assert.rejects(runMandateJob({ mandate: m.publicKey }, d), /failed on chain/);
  assert.deepEqual(calls, ["sign", "simulate", "record"]);
});

test("a jitoSOL health trigger is decided by simulation against its own feed", async () => {
  const o = offer({ wsolMint: k() });
  const m = mandate(o);
  const { d, calls } = deps(m, o, null, NOW + 86_400);
  assert.equal((await runMandateJob({ mandate: m.publicKey }, d)).result, "executed");
  assert.deepEqual(calls, ["sign", "simulate", "record", "send"]);
});

test("the scan queues one job per mandate, execution and window, and only when due", () => {
  const o = offer();
  const due = mandate(o);
  const idle = mandate(o, { armed: false });
  const jobs = mandateJobsDue([due, idle], new Map([[o.publicKey, o]]), price(135), NOW);
  assert.deepEqual(jobs.map((j) => j.payload.mandate), [due.publicKey]);
  const again = mandateJobsDue([due], new Map([[o.publicKey, o]]), price(135), NOW + 1);
  assert.equal(again[0].dedupKey, jobs[0].dedupKey, "same window, same key: the queue dedups");
  const later = mandateJobsDue([{ ...due, executions: 1 }], new Map([[o.publicKey, o]]), price(135), NOW + MANDATE_JOB_WINDOW_SECONDS);
  assert.notEqual(later[0].dedupKey, jobs[0].dedupKey);
});

test("a repay mandate never plans more than the payoff", async () => {
  const o = offer();
  const m = mandate(o, { action: ACTION_REPAY, trigger: TRIGGER_TIME, triggerLtvBps: 0, leadSeconds: 86_400, amountPerExec: 500_000_000n, cumulativeCap: 600_000_000n, expiry: NOW + 60 * 86_400 });
  const at = maturity(terms) - 86_400;
  const { d } = deps(m, o, null, at);
  const { decideMandate } = await import("../v2/mandates");
  const decision = decideMandate(m, o, null, at);
  assert.ok(decision.due);
  if (decision.due) assert.equal(decision.plan.amount, payoff(terms, o.ledger, at));
  assert.equal((await runMandateJob({ mandate: m.publicKey }, d)).result, "executed");
});

test("mandates are servicing: an originations pause never blocks them, and the capability follows its flag", () => {
  assert.equal(ORIGINATING.has("mandate"), false);
  assert.equal(loanActionAllowed("mandate", [{ key: "originations", paused: true }]).allowed, true);
  const cap = capabilityFor("zenlo-public", "devnet", DEVNET_USDC, "automate");
  assert.equal(cap.available, process.env.NEXT_PUBLIC_MANDATES_ENABLED === "1");
});
