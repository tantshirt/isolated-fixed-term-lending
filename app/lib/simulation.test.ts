import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SIM_DRAFT,
  initialSimulation,
  restoreSimulation,
  serializeSimulation,
  transition,
  type Simulation,
} from "./simulation";
function open() {
  return transition(initialSimulation(), {
    action: "create",
    draft: DEFAULT_SIM_DRAFT,
  });
}
function filled() {
  const s = open();
  s.role = "borrower";
  return transition(s, { action: "accept" });
}
function totals(s: Simulation) {
  const vaultUsdc = s.loan?.status === "open" ? s.loan.principal : 0n;
  const vaultWsol = s.loan?.status === "filled" ? s.loan.collateralAmount : 0n;
  return {
    usdc: Object.values(s.balances).reduce((n, b) => n + b.usdc, vaultUsdc),
    wsol: Object.values(s.balances).reduce((n, b) => n + b.wsol, vaultWsol),
  };
}
test("repayment conserves every atom and charges full interest even immediately", () => {
  let s = filled();
  s = transition(s, { action: "repay" });
  assert.equal(s.balances.lender.usdc, 1005000000n);
  assert.equal(s.balances.borrower.wsol, 10000000000n);
  assert.deepEqual(totals(s), totals(initialSimulation()));
  assert.throws(() => transition(s, { action: "repay" }), /already settled/);
});
test("all authorities are enforced; closing is lender-only and settled-only", () => {
  let s = filled();
  s.role = "lender";
  assert.throws(() => transition(s, { action: "repay" }), /Only the borrower/);
  assert.throws(() => transition(s, { action: "close" }), /Settle/);
  s.role = "borrower";
  assert.throws(
    () => transition(s, { action: "liquidate" }),
    /cannot liquidate/
  );
  s = transition(s, { action: "repay" });
  assert.throws(() => transition(s, { action: "close" }), /Only the lender/);
  s.role = "lender";
  s = transition(s, { action: "close" });
  assert.equal(s.loan?.status, "closed");
  assert.throws(() => transition(s, { action: "close" }), /No open receipt/);
});
test("create, accept and cancel reject wrong actor or state", () => {
  let s = initialSimulation();
  s.role = "borrower";
  assert.throws(
    () => transition(s, { action: "create", draft: DEFAULT_SIM_DRAFT }),
    /Only the lender/
  );
  s = open();
  assert.throws(
    () => transition(s, { action: "accept" }),
    /Switch to the borrower/
  );
  s.role = "borrower";
  assert.throws(() => transition(s, { action: "cancel" }), /Only the lender/);
  s.role = "lender";
  s = transition(s, { action: "cancel" });
  assert.deepEqual(totals(s), totals(initialSimulation()));
  assert.equal(s.balances.lender.usdc, 1000000000n);
});
test("expiry boundary rejects repayment and liquidation at the exact deadline, any caller can claim", () => {
  let s = filled();
  s.now = s.loan!.expiry - 1;
  assert.equal(transition(s, { action: "repay" }).loan?.status, "repaid");
  assert.throws(() => transition(s, { action: "claim" }), /not expired/);
  s.now++;
  assert.throws(() => transition(s, { action: "repay" }), /deadline/);
  s.role = "liquidator";
  assert.throws(() => transition(s, { action: "liquidate" }), /deadline/);
  s = transition(s, { action: "claim" });
  assert.equal(s.balances.lender.wsol, 1100000000n);
  assert.deepEqual(totals(s), totals(initialSimulation()));
});
test("liquidation exact split and conservation; healthy liquidation rejected", () => {
  let s = filled();
  s.role = "liquidator";
  assert.throws(() => transition(s, { action: "liquidate" }), /threshold/);
  s.price = 11900000000n;
  s.conf = 0n;
  s = transition(s, { action: "liquidate" });
  assert.equal(s.balances.liquidator.wsol, 926470589n);
  assert.equal(s.balances.borrower.wsol, 9073529411n);
  assert.equal(s.balances.lender.usdc, 1005000000n);
  assert.deepEqual(totals(s), totals(initialSimulation()));
});
test("oracle age 60 succeeds, 61 fails, future/invalid confidence fails closed", () => {
  const s = open();
  s.role = "borrower";
  s.now += 60;
  assert.equal(transition(s, { action: "accept" }).loan?.status, "filled");
  s.now++;
  assert.throws(() => transition(s, { action: "accept" }), /stale/);
  s.publishTime = s.now + 1;
  assert.throws(() => transition(s, { action: "accept" }), /future/);
  s.publishTime = s.now;
  s.conf = s.price / 10n;
  assert.throws(() => transition(s, { action: "accept" }), /confidence/);
});
test("insufficient balances fail atomically, oversized program amounts rejected", () => {
  const s = filled();
  s.balances.borrower.usdc = 1n;
  const copy = serializeSimulation(s);
  assert.throws(() => transition(s, { action: "repay" }), /insufficient/);
  assert.equal(serializeSimulation(s), copy);
  assert.throws(
    () =>
      transition(initialSimulation(), {
        action: "create",
        draft: { ...DEFAULT_SIM_DRAFT, principal: "18446744073709.551616" },
      }),
    /integer limit/
  );
});
test("versioned bigint serialization round trips and malformed or partial state recovers safely", () => {
  const s = filled();
  assert.deepEqual(restoreSimulation(serializeSimulation(s)), s);
  for (const raw of [
    "{",
    "null",
    "{}",
    '{"version":2}',
    serializeSimulation({ ...s, balances: null } as unknown as Simulation),
    serializeSimulation({ ...s, loan: { ...s.loan!, debt: 1n } }),
  ])
    assert.equal(restoreSimulation(raw), null);
});
test("acceptance includes exact max LTV; liquidation includes exact liquidation LTV", () => {
  let s = transition(initialSimulation(), {
    action: "create",
    draft: { ...DEFAULT_SIM_DRAFT, collateral: "1" },
  });
  s.role = "borrower";
  s.conf = 0n;
  assert.equal(transition(s, { action: "accept" }).loan?.status, "filled");
  s.price = 14900000000n;
  assert.throws(() => transition(s, { action: "accept" }), /insufficient/);
  s = transition(initialSimulation(), {
    action: "create",
    draft: { ...DEFAULT_SIM_DRAFT, collateral: "1.05" },
  });
  s.role = "borrower";
  s = transition(s, { action: "accept" });
  s.role = "liquidator";
  s.conf = 0n;
  s.price = 12500000000n;
  const settled = transition(s, { action: "liquidate" });
  assert.equal(settled.loan?.status, "liquidated");
  assert.equal(settled.balances.liquidator.wsol, 882000000n);
  assert.deepEqual(totals(settled), totals(initialSimulation()));
});
test("storage rejects apparently shaped records with forged ledger balances", () => {
  const s = filled();
  s.balances.lender.usdc += 1n;
  assert.equal(restoreSimulation(serializeSimulation(s)), null);
});
