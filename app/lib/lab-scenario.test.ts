import assert from "node:assert/strict";
import { test } from "node:test";
import { scenarioFrom } from "./lab-scenario";

const bytes = (a: number, b: number, c: number, d: number) => Uint8Array.from([a, b, c, d, ...new Array(28).fill(0)]);

test("a small drop and early repayment is repaid", () => {
  const s = scenarioFrom(bytes(0, 0, 0, 1)); // 5% drop on day 1, repays day 2
  assert.equal(s.dropPercent, 5);
  assert.equal(s.outcome, "repaid");
});

test("a deep drop before repayment is liquidated", () => {
  const s = scenarioFrom(bytes(35, 0, 0, 5)); // 40% drop on day 1, repays day 6
  assert.ok(s.ltvAfterDropBps >= 8000);
  assert.equal(s.outcome, "liquidated");
});

test("repaying before a deep drop is still repaid", () => {
  const s = scenarioFrom(bytes(35, 5, 0, 0)); // drop day 6, repays day 1
  assert.equal(s.outcome, "repaid");
});

test("never repaying with a mild drop expires", () => {
  const s = scenarioFrom(bytes(0, 0, 200, 0));
  assert.equal(s.repayDay, null);
  assert.equal(s.outcome, "expired");
});

test("the same randomness always gives the same scenario", () => {
  const r = Uint8Array.from({ length: 32 }, (_, i) => (i * 37) % 256);
  assert.deepEqual(scenarioFrom(r), scenarioFrom(r));
});
