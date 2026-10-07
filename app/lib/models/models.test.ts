import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { legacyLoanView } from "./loan-view";
import { collateralAsset, COLLATERAL_ASSETS, JITOSOL_USD_FEED_ID_HEX, selectableCollateral } from "./collateral";
import { capabilityFor } from "../capabilities";
import type { Offer } from "../offers";
import type { PriceSnapshot } from "../offer-status";

const NOW = 1_800_000_000;
const k = () => Keypair.generate().publicKey.toBase58();
const offer = (over: Partial<Offer> = {}): Offer => ({
  publicKey: k(), lender: k(), borrower: k(), offerId: 1n, usdcMint: "u", wsolMint: "w",
  principal: 100_000_000n, interestBps: 500, durationSeconds: 86_400, collateralAmount: 1_001_001_002n,
  maxLtvBps: 7000, liquidationLtvBps: 8000, startTs: NOW - 100, expiryTs: NOW + 1000, status: "filled", ...over,
});
const price = (usd: number, fresh = true): PriceSnapshot => ({ price: BigInt(Math.round(usd * 1e8)), conf: 0n, exponent: -8, publishTime: NOW, fresh });
const can = (v: ReturnType<typeof legacyLoanView>, a: string) => v.actions.find((x) => x.action === a)?.available;

test("an active legacy loan pays principal plus full-term interest", () => {
  const v = legacyLoanView(offer(), price(150), NOW);
  assert.equal(v.payoff, 105_000_000n);
  assert.equal(v.remainingPrincipal, 100_000_000n);
  assert.equal(can(v, "repay"), true);
  assert.equal(can(v, "claim"), false);
  assert.equal(can(v, "liquidate"), false);
  assert.equal(v.risk?.liquidatable, false);
});

test("at the exact expiry second repay closes and claim opens", () => {
  const o = offer();
  const v = legacyLoanView(o, price(150), o.expiryTs);
  assert.equal(can(v, "repay"), false);
  assert.equal(can(v, "claim"), true);
});

test("a price drop past the line makes the loan liquidatable before expiry", () => {
  const v = legacyLoanView(offer(), price(120), NOW);
  assert.equal(v.risk?.liquidatable, true);
  assert.equal(can(v, "liquidate"), true);
});

test("pausing originations hides accept but never repay", () => {
  const flags = [{ key: "originations" as const, paused: true }];
  assert.equal(can(legacyLoanView(offer({ status: "open", borrower: null }), price(150), NOW, flags), "accept"), false);
  assert.equal(can(legacyLoanView(offer(), price(150), NOW, flags), "repay"), true);
});

test("without a price the risk is unknown rather than healthy", () => {
  const v = legacyLoanView(offer(), null, NOW);
  assert.equal(v.risk, null);
  assert.equal(can(v, "liquidate"), false);
});

test("only enabled collateral resolves", () => {
  assert.equal(collateralAsset("So11111111111111111111111111111111111111112")?.symbol, "wSOL");
  const jito = COLLATERAL_ASSETS.find((a) => a.symbol === "jitoSOL")!;
  assert.equal(collateralAsset(jito.mint), null);
  assert.ok(jito.liquidationLtvBps - jito.maxLtvBps >= 500);
});

test("jitoSOL (test) has its own feed and caps and stays off without the flag", () => {
  const jito = COLLATERAL_ASSETS.find((a) => a.symbol === "jitoSOL")!;
  assert.equal(jito.label, "jitoSOL (test)");
  assert.equal(jito.feedIdHex, JITOSOL_USD_FEED_ID_HEX);
  assert.notEqual(jito.feedIdHex, COLLATERAL_ASSETS[0].feedIdHex);
  assert.deepEqual([jito.decimals, jito.maxLtvBps, jito.liquidationLtvBps], [9, 6_000, 7_000]);
  assert.equal(jito.enabled, false);
  assert.deepEqual(selectableCollateral().map((a) => a.symbol), ["wSOL"]);
  const origination = capabilityFor("zenlo-public", "devnet", jito.mint || "jitosol-test-unset", "originate");
  assert.equal(origination.available, false);
});

import { v2LoanView } from "./loan-view";
import { EarlyRepayment, graceEnd, maturity, openLedger, pricedRecoveryFrom, terminalClaimFrom, type TermsV2 } from "../loan-math-v2";
import type { OfferV2 } from "../v2/offers";

const v2terms: TermsV2 = { principal: 100_000_000n, interestBps: 500, duration: 30 * 86_400, startTs: NOW, earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 2500, graceSeconds: 86_400, lateFeeBps: 100, annualCeilingBps: 10_000 };
const v2offer = (over: Partial<OfferV2> = {}): OfferV2 => ({
  generation: "v2", publicKey: k(), version: 2, originLender: k(), currentLender: k(), borrower: k(), restrictedBorrower: null, offerId: 1n,
  usdcMint: "u", wsolMint: "w", terms: v2terms, collateralRequired: 1_020_000_000n, collateralLocked: 1_020_000_000n, maxLtvBps: 7000,
  liquidationLtvBps: 8000, status: "active", ledger: openLedger(v2terms), shortfall: 0n, settledTs: 0, ...over,
});
const withEma = (spot: number, ema: number): PriceSnapshot => ({ ...price(spot), ema: { price: BigInt(Math.round(ema * 1e8)), conf: 0n } });
const v2can = (v: ReturnType<typeof v2LoanView>, a: string) => v.actions.find((x) => x.action === a);

test("V2 repayment stays open in every phase until settlement", () => {
  for (const at of [NOW + 10, maturity(v2terms), graceEnd(v2terms), pricedRecoveryFrom(v2terms), terminalClaimFrom(v2terms) + 86_400]) {
    assert.equal(v2can(v2LoanView(v2offer(), price(150), at), "repay")?.available, true, String(at));
  }
  assert.equal(v2can(v2LoanView(v2offer({ status: "terminalClaimed" }), price(150), NOW), "repay"), undefined);
});

test("V2 windows open on their exact seconds and explain when they open", () => {
  const before = v2LoanView(v2offer(), price(150), graceEnd(v2terms) - 1);
  assert.equal(before.phase, "Grace");
  assert.equal(v2can(before, "liquidate-overdue")?.available, false);
  assert.match(v2can(before, "liquidate-overdue")!.reason!, /Opens when grace ends/);
  assert.equal(v2can(v2LoanView(v2offer(), price(150), graceEnd(v2terms)), "liquidate-overdue")?.available, true);
  assert.equal(v2can(v2LoanView(v2offer(), price(150), pricedRecoveryFrom(v2terms)), "claim-priced")?.available, true);
  assert.equal(v2can(v2LoanView(v2offer(), null, terminalClaimFrom(v2terms)), "claim-terminal")?.available, true, "the final claim needs no price");
});

test("V2 risk liquidation follows the program's spot-and-EMA rule", () => {
  assert.equal(v2LoanView(v2offer(), withEma(120, 150), NOW + 86_400).risk?.liquidatable, false);
  assert.equal(v2LoanView(v2offer(), withEma(119, 150), NOW + 86_400).risk?.trigger, "Emergency");
  assert.equal(v2LoanView(v2offer(), withEma(120, 120), NOW + 86_400).risk?.trigger, "Ordinary");
  assert.equal(v2LoanView(v2offer(), withEma(150, 150), NOW + 86_400).payoff, 101_250_000n);
});
