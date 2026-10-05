import assert from "node:assert/strict";
import { test } from "node:test";
import { collateralValueUsdc, currentLtvBps } from "./loan-math";
import { minCollateralLamports, plannedLtvBps, solPriceAtLtv } from "./risk";

const p150 = { price: 15_000_000_000n, conf: 15_000_000n, exponent: -8 };

test("minimum collateral lands exactly on max LTV, as in the research note", () => {
  const min = minCollateralLamports(105_000_000n, 7_000, p150);
  assert.equal(currentLtvBps(105_000_000n, collateralValueUsdc(min, p150.price, p150.conf, p150.exponent)), 7_000);
  // One lamport less must break the cap.
  assert.ok(plannedLtvBps(105_000_000n, min - 1n, p150) > 7_000);
  assert.equal(min, 1_001_001_002n);
});

test("liquidation price for the worked example is $131.12", () => {
  const px = solPriceAtLtv(105_000_000n, 1_001_001_002n, 8_000);
  assert.ok(Math.abs(px - 131.118) < 0.01, String(px));
});

test("u64Le matches Buffer.writeBigUInt64LE", async () => {
  const { u64Le } = await import("./pda");
  for (const v of [0n, 1n, 42n, 2n ** 63n + 5n, 2n ** 64n - 1n]) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    assert.deepEqual(Buffer.from(u64Le(v)), b);
  }
});
