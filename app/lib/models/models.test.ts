import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { legacyLoanView } from "./loan-view";
import { collateralAsset, COLLATERAL_ASSETS } from "./collateral";
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
