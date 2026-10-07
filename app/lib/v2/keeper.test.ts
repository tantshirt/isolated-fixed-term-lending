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
