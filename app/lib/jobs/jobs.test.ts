import test from "node:test";
import assert from "node:assert/strict";
import { afterError, afterLeaseExpired, reconcile, retryDelayMs, MAX_ATTEMPTS } from "./policy";
import { crankParity } from "./crank-parity";
import { capabilityFor, DEVNET_USDC, WSOL } from "../capabilities";
import { loanActionAllowed, providerAllowed, ORIGINATING, type LoanAction } from "../ops-flags";

test("backoff doubles, caps at 30 minutes and bounds jitter", () => {
  assert.equal(retryDelayMs(1), 15_000);
  assert.equal(retryDelayMs(2), 30_000);
  assert.equal(retryDelayMs(20), 30 * 60_000);
  assert.equal(retryDelayMs(1, 1), 18_000);
  assert.equal(retryDelayMs(1, 5), 18_000);
});

test("an uncertain signature is never resubmitted while it could still land", () => {
  assert.equal(reconcile({ kind: "unknown", blockhashExpired: false }), "wait");
  assert.equal(reconcile({ kind: "unknown", blockhashExpired: true }), "retry");
  assert.equal(reconcile({ kind: "confirmed" }), "succeeded");
  assert.equal(reconcile({ kind: "failed", error: "x" }), "retry");
});

test("retries are bounded and a lost lease with a signature becomes uncertain", () => {
  assert.equal(afterError(1), "queued");
  assert.equal(afterError(MAX_ATTEMPTS), "failed");
  assert.equal(afterLeaseExpired(true), "uncertain");
  assert.equal(afterLeaseExpired(false), "queued");
});

test("crank parity reports cranks the live scheduler missed, after the grace window", () => {
  const t = 1_000_000;
  const obs = [
    { source: "shadow" as const, at: t, due: ["a", "b"], triggered: [] },
    { source: "live" as const, at: t + 60_000, due: [], triggered: ["a", "z"] },
  ];
  assert.deepEqual(crankParity(obs, t + 60_000).missedByLive, []);
  const later = crankParity(obs, t + 10 * 60_000);
  assert.deepEqual(later.missedByLive, ["b"]);
  assert.deepEqual(later.unseenByShadow, ["z"]);
  assert.equal(later.shadowScans, 1);
  assert.equal(later.liveRuns, 1);
});

test("capabilities are specific to network and mint and explain unavailability", () => {
  assert.deepEqual(capabilityFor("zenlo-public", "devnet", DEVNET_USDC, "originate"), { available: true });
  const wrongMint = capabilityFor("zenlo-public", "devnet", WSOL, "originate");
  assert.equal(wrongMint.available, false);
  const mg = capabilityFor("moneygram", "devnet", DEVNET_USDC, "cash-out");
  assert.equal(mg.available, false);
  if (!mg.available) {
    assert.equal(mg.simulationOnly, true);
    assert.match(mg.reason, /sandbox/);
  }
  assert.equal(capabilityFor("moneygram", "mainnet", DEVNET_USDC, "cash-out").available, false);
});

test("pausing originations never blocks servicing or recovery", () => {
  const flags = [{ key: "originations" as const, paused: true }];
  const all: LoanAction[] = ["create-offer", "create-request", "accept", "fund", "propose", "repay", "add-collateral", "liquidate", "claim", "cancel", "close", "withdraw"];
  for (const a of all) assert.equal(loanActionAllowed(a, flags).allowed, !ORIGINATING.has(a), a);
  assert.equal(loanActionAllowed("accept", []).allowed, true);
  assert.equal(providerAllowed("moneygram", [{ key: "provider:moneygram", paused: true }]).allowed, false);
  assert.equal(providerAllowed("telegram", [{ key: "provider:moneygram", paused: true }]).allowed, true);
});
