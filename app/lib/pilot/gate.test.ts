import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { evaluateGate, isDeveloperWallet, type PilotEvent } from "./gate";

const DEV = "3dh3Bxu1hJzH3aHfwNAibRqTxyrPsUFyteiuGxycoohh";
const wallet = () => Keypair.generate().publicKey.toBase58();

function passingPilot(): PilotEvent[] {
  const operators = Array.from({ length: 5 }, wallet);
  const events: PilotEvent[] = operators.map((operator, i) => ({ kind: "desk_activated", deskId: `d${i}`, operator, at: i }));
  // 10 loans across 3 desks; the first three operators each lend at least twice.
  const plan = [0, 0, 0, 0, 1, 1, 1, 2, 2, 2];
  plan.forEach((desk, i) =>
    events.push({
      kind: "loan_confirmed",
      deskId: `d${desk}`,
      lender: operators[desk],
      borrower: wallet(),
      signers: [],
      assisted: i === 0,
      at: 100 + i,
    }),
  );
  return events;
}

test("a pilot meeting every threshold passes", () => {
  const report = evaluateGate(passingPilot());
  assert.equal(report.passed, true, report.failing.join());
  assert.equal(report.activatedDesks, 5);
  assert.equal(report.confirmedLoans, 10);
  assert.equal(report.desksWithLoans, 3);
  assert.equal(report.returningLenders, 3);
  assert.equal(report.unassistedShare, 0.9);
});

test("developer wallets are excluded wherever they appear", () => {
  assert.equal(isDeveloperWallet(DEV), true);
  const events = passingPilot();
  const loan = events.find((e) => e.kind === "loan_confirmed")!;
  if (loan.kind === "loan_confirmed") loan.signers = [DEV];
  const report = evaluateGate(events);
  assert.equal(report.excludedEvents, 1);
  assert.equal(report.confirmedLoans, 9);
  assert.equal(report.passed, false);
  assert.deepEqual(report.failing, ["confirmedLoans"]);
});

test("one operator with several desks counts once", () => {
  const op = wallet();
  const events: PilotEvent[] = Array.from({ length: 5 }, (_, i) => ({ kind: "desk_activated", deskId: `d${i}`, operator: op, at: i }));
  assert.equal(evaluateGate(events).activatedDesks, 1);
});

test("too many assisted originations fails the unassisted share", () => {
  const events = passingPilot().map((e) => (e.kind === "loan_confirmed" ? { ...e, assisted: e.at < 103 } : e));
  const report = evaluateGate(events);
  assert.equal(report.unassistedShare, 0.7);
  assert.deepEqual(report.failing, ["unassistedShare"]);
});

test("no loans is not a pass", () => {
  const report = evaluateGate([]);
  assert.equal(report.unassistedShare, null);
  assert.equal(report.passed, false);
});
