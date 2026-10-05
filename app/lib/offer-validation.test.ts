import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAmount, parseDraft, validateDraft, type OfferDraft } from "./offer-validation";

const good: OfferDraft = {
  principal: "100",
  interestBps: 500,
  durationSeconds: 7 * 86_400,
  collateral: "1.001001002",
  maxLtvBps: 7_000,
  liquidationLtvBps: 8_000,
};

test("parseAmount reads plain decimals and rejects the rest", () => {
  assert.equal(parseAmount("100", 6), 100_000_000n);
  assert.equal(parseAmount("1,000.5", 6), 1_000_500_000n);
  assert.equal(parseAmount(".5", 6), 500_000n);
  assert.equal(parseAmount("1.001001002", 9), 1_001_001_002n);
  assert.equal(parseAmount("1.0000001", 6), null);
  for (const bad of ["", "abc", "-1", "1e5", "1.2.3", "NaN"]) assert.equal(parseAmount(bad, 6), null, bad);
});

test("the worked example parses to the program's numbers", () => {
  const p = parseDraft(good)!;
  assert.equal(p.principal, 100_000_000n);
  assert.equal(p.debt, 105_000_000n);
  assert.equal(p.collateralAmount, 1_001_001_002n);
});

test("caps match constants.rs", () => {
  assert.ok(validateDraft({ ...good, interestBps: 2_001 }).interestBps);
  assert.ok(validateDraft({ ...good, durationSeconds: 59 }).durationSeconds);
  assert.ok(validateDraft({ ...good, durationSeconds: 7_776_001 }).durationSeconds);
  assert.ok(validateDraft({ ...good, maxLtvBps: 7_001 }).maxLtvBps);
  assert.ok(validateDraft({ ...good, liquidationLtvBps: 7_499 }).liquidationLtvBps);
  assert.ok(validateDraft({ ...good, maxLtvBps: 6_000, liquidationLtvBps: 8_501 }).liquidationLtvBps);
  assert.deepEqual(validateDraft({ ...good, maxLtvBps: 7_000, liquidationLtvBps: 7_500 }), {});
  assert.ok(validateDraft({ ...good, principal: "0" }).principal);
  assert.ok(validateDraft({ ...good, collateral: "" }).collateral);
  assert.equal(parseDraft({ ...good, principal: "x" }), null);
});
