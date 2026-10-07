import test from "node:test";
import assert from "node:assert/strict";
import { EarlyRepayment, type TermsV2 } from "../loan-math-v2";
import { advance, pay, settle, settlementNow, simPayoff, simPhase, startSim, topUp } from "./simulator";

const T: TermsV2 = { principal: 100_000_000n, interestBps: 500, duration: 30 * 86_400, startTs: 1_800_000_000, earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 2500, graceSeconds: 86_400, lateFeeBps: 100, annualCeilingBps: 10_000 };

test("the simulator's payoff matches the program math through partials and grace", () => {
  let s = startSim(T, 1_020_000_000n);
  s = advance(s, 10 * 86_400);
  s = pay(s, 30_000_000n);
  assert.equal(s.ledger.interestPaid, 1_666_666n);
  s = topUp(s, 500_000_000n);
  s = advance(s, 20 * 86_400 + 3_600);
  assert.equal(simPhase(s), "Grace");
  const owed = simPayoff(s);
  s = pay(s, owed);
  assert.equal(s.status, "repaid");
  assert.match(s.log.at(-1)!, /All 1.5200 wSOL returns/);
});

test("settlements only open in their windows and the last one wins once", () => {
  let s = advance(startSim(T, 1_020_000_000n), 30 * 86_400 + 86_399);
  assert.equal(settlementNow(s), null);
  s = advance(s, 1);
  assert.equal(settlementNow(s), "overdue-liquidation");
  s = advance(s, 7 * 86_400);
  assert.equal(settlementNow(s), "terminal-claim");
  const done = settle(s, "terminal-claim");
  assert.equal(done.status, "terminal-claimed");
  assert.equal(settle(done, "priced-recovery"), done);
  assert.equal(pay(done, 1n), done);
});
