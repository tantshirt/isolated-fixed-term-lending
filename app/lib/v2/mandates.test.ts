import test from "node:test";
import assert from "node:assert/strict";
import { ACTION_REPAY, ACTION_TOP_UP, planMandate, TRIGGER_HEALTH, TRIGGER_TIME, validateBounds, type MandateBounds } from "./mandates";

const health: MandateBounds = {
  action: ACTION_TOP_UP, trigger: TRIGGER_HEALTH, triggerLtvBps: 7_500, leadSeconds: 0, amountPerExec: 100n, cumulativeCap: 250n, feePerExec: 5n, feeCap: 10n, expiry: 1_000,
};

// Same cases as loan_core::mandate's unit tests, so the interface and the program agree.
test("bounds validate exactly as the program does", () => {
  assert.equal(validateBounds(health, 0, 8_000, 100), null);
  assert.ok(validateBounds({ ...health, triggerLtvBps: 8_000 }, 0, 8_000, 100));
  assert.ok(validateBounds({ ...health, triggerLtvBps: 200 }, 0, 8_000, 100));
  assert.ok(validateBounds({ ...health, feeCap: 300n }, 0, 8_000, 100));
  assert.ok(validateBounds({ ...health, feePerExec: 11n }, 0, 8_000, 100));
  assert.ok(validateBounds(health, 1_000, 8_000, 100));
  const time = { ...health, trigger: TRIGGER_TIME, triggerLtvBps: 0, leadSeconds: 50 } as const;
  assert.equal(validateBounds(time, 0, 8_000, 100), null);
  assert.ok(validateBounds({ ...time, leadSeconds: 101 }, 0, 8_000, 100));
  assert.equal(validateBounds({ ...health, action: ACTION_REPAY }, 0, 8_000, 100), null);
});

test("amounts clamp to the cap and payoff; fees never pass their bounds", () => {
  const m = { ...health, used: 0n, feesPaid: 0n };
  assert.deepEqual(planMandate(m, 5n, null), { amount: 100n, fee: 5n });
  assert.deepEqual(planMandate({ ...m, used: 210n, feesPaid: 5n }, 5n, null), { amount: 35n, fee: 5n });
  assert.equal(planMandate({ ...m, used: 245n, feesPaid: 5n }, 5n, null), "cap-reached");
  assert.equal(planMandate(m, 6n, null), "fee-above-cap");
  assert.equal(planMandate({ ...m, feesPaid: 8n }, 5n, null), "fee-above-cap");
  assert.deepEqual(planMandate(m, 0n, 40n), { amount: 40n, fee: 0n });
});
