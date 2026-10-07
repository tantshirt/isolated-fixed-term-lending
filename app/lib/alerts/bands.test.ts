import test from "node:test";
import assert from "node:assert/strict";
import { dueReminders, liquidationPrice, nextLevel, rawLevel, remindersFor, step, riskNotificationKey } from "./bands";

const base = { baseline: 150, liquidationPrice: 100, eligible: false };

test("levels follow buffer use, then absolute distance, then eligibility", () => {
  assert.equal(rawLevel({ ...base, price: 140 }), 0);
  assert.equal(rawLevel({ ...base, price: 137.5 }), 1);
  assert.equal(rawLevel({ ...base, price: 125 }), 2);
  assert.equal(rawLevel({ ...base, price: 112.5 }), 3);
  assert.equal(rawLevel({ ...base, price: 105 }), 4);
  assert.equal(rawLevel({ ...base, price: 102 }), 5);
  assert.equal(rawLevel({ ...base, price: 99 }), 5);
  assert.equal(rawLevel({ ...base, price: 140, eligible: true }), 6);
});

test("the liquidation price puts the payoff exactly on the line", () => {
  const lp = liquidationPrice(80_000_000n, 1_000_000_000n, 8_000);
  assert.ok(Math.abs(lp - 100) < 1e-9);
});

test("hysteresis: rises at once, falls only after a clear recovery", () => {
  assert.equal(nextLevel(0, { ...base, price: 125 }), 2);
  assert.equal(nextLevel(2, { ...base, price: 126 }), 2, "a hair above the threshold keeps the level");
  assert.equal(nextLevel(2, { ...base, price: 140 }), 1, "falls one step while still near the 25% line");
  assert.equal(nextLevel(2, { ...base, price: 145 }), 0);
});

test("each level is announced once, and again only after a full recovery", () => {
  let r = step(null, { price: 150, liquidationPrice: 100, eligible: false, basis: "b1" });
  assert.equal(r.send, null);
  r = step(r.state, { price: 125, liquidationPrice: 100, eligible: false, basis: "b1" });
  assert.equal(r.send, 2);
  r = step(r.state, { price: 124, liquidationPrice: 100, eligible: false, basis: "b1" });
  assert.equal(r.send, null, "deduplicated");
  r = step(r.state, { price: 149, liquidationPrice: 100, eligible: false, basis: "b1" });
  assert.equal(r.state.level, 0);
  r = step(r.state, { price: 125, liquidationPrice: 100, eligible: false, basis: "b1" });
  assert.equal(r.send, 2, "announced again after recovery");
});

test("a payment or top-up rebases on the next valid price", () => {
  let r = step(null, { price: 150, liquidationPrice: 100, eligible: false, basis: "rev0" });
  r = step(r.state, { price: 125, liquidationPrice: 100, eligible: false, basis: "rev0" });
  assert.equal(r.send, 2);
  r = step(r.state, { price: 125, liquidationPrice: 80, eligible: false, basis: "rev1" });
  assert.equal(r.state.baseline, 125);
  assert.equal(r.state.level, 0);
  assert.equal(r.send, null);
});

test("reminders cover the deadline and every V2 window, each once and not stale", () => {
  const all = remindersFor({ maturity: 1_000_000, graceEnd: 1_086_400, pricedFrom: 1_172_800, terminalFrom: 1_691_200 });
  assert.deepEqual(all.map((r) => r.key), ["maturity-24h", "maturity-1h", "grace-start", "grace-end-1h", "priced-recovery", "terminal-24h", "terminal"]);
  assert.deepEqual(dueReminders(all, [], 1_000_000 - 3_600).map((r) => r.key), ["maturity-24h", "maturity-1h"]);
  assert.deepEqual(dueReminders(all, ["maturity-24h", "maturity-1h"], 1_000_000).map((r) => r.key), ["grace-start"]);
  assert.deepEqual(dueReminders(all, [], 1_200_000).map((r) => r.key), ["priced-recovery"], "reminders more than a day late are skipped");
});


test("recovered and rebased warnings get new delivery keys", () => {
  let r = step(null, { price: 150, liquidationPrice: 100, eligible: false, basis: "b" });
  r = step(r.state, { price: 125, liquidationPrice: 100, eligible: false, basis: "b" });
  const first = riskNotificationKey(r.state, r.send!);
  r = step(r.state, { price: 150, liquidationPrice: 100, eligible: false, basis: "b" });
  r = step(r.state, { price: 125, liquidationPrice: 100, eligible: false, basis: "b" });
  assert.equal(r.send, 2);
  assert.notEqual(riskNotificationKey(r.state, r.send!), first);
});

test("a crossed spot line is not liquidation eligibility when EMA or phase blocks settlement", () => {
  assert.equal(rawLevel({ ...base, price: 99 }), 5);
  assert.equal(nextLevel(6, { ...base, price: 99 }), 5);
  assert.equal(rawLevel({ ...base, price: 99, eligible: true }), 6);
});
