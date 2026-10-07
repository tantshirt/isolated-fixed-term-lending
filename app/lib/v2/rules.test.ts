import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, readRules, reviewFigures, rulesProblem, suggestCeilingBps, termsFrom } from "./rules";
import { chargeCeiling, fullTermInterest, validateTermsV2 } from "../loan-math-v2";

test("the suggested ceiling fits the interest and the late fee in 5% steps", () => {
  const c = suggestCeilingBps(100_000_000n, 500, 30 * 86_400, DEFAULT_RULES)!;
  assert.equal(c % 500, 0);
  const t = termsFrom({ principal: 100_000_000n, interestBps: 500, durationSeconds: 30 * 86_400 }, DEFAULT_RULES)!;
  assert.equal(t.annualCeilingBps, c);
  assert.equal(validateTermsV2(t), null);
  assert.ok(chargeCeiling(t) >= fullTermInterest(t) + 1_000_000n, "the late fee is not clamped under the suggestion");
  const lower = { ...t, annualCeilingBps: c - 500 };
  assert.ok(chargeCeiling(lower) < fullTermInterest(t) + 1_000_000n);
});

test("terms beyond the protocol maximum explain themselves", () => {
  assert.equal(suggestCeilingBps(100_000_000n, 2_000, 60, DEFAULT_RULES), null);
  assert.match(rulesProblem({ principal: 100_000_000n, interestBps: 2_000, durationSeconds: 60 }, DEFAULT_RULES)!, /highest pricing ceiling/);
  assert.match(rulesProblem({ principal: 100_000_000n, interestBps: 500, durationSeconds: 30 * 86_400 }, { ...DEFAULT_RULES, annualCeilingBps: 1_000 })!, /above the annual pricing ceiling/);
  assert.equal(rulesProblem({ principal: null, interestBps: 500, durationSeconds: 60 }, DEFAULT_RULES), null);
});

test("stored rules fall back to defaults field by field", () => {
  assert.deepEqual(readRules(undefined), DEFAULT_RULES);
  assert.deepEqual(readRules({ earlyRepayment: "full-term", graceSeconds: 172_800, lateFeeBps: 999 }), { ...DEFAULT_RULES, earlyRepayment: "full-term", graceSeconds: 172_800 });
});

test("review figures put every deadline after the one before", () => {
  const t = termsFrom({ principal: 100_000_000n, interestBps: 500, durationSeconds: 30 * 86_400 }, DEFAULT_RULES)!;
  const f = reviewFigures(t, 1_800_000_000);
  assert.equal(f.termCost, 5_000_000n);
  assert.equal(f.minInterest, 1_250_000n);
  assert.equal(f.maxExposure, 106_000_000n);
  assert.ok(f.maturity < f.graceEnd && f.graceEnd < f.pricedRecoveryFrom && f.pricedRecoveryFrom < f.terminalClaimFrom);
  assert.equal(f.terminalClaimFrom - f.graceEnd, 604_800);
});
