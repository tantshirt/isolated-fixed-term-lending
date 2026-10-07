import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { EarlyRepayment, openLedger, type TermsV2 } from "../loan-math-v2";
import type { RoomMessage } from "./room-codec";
import type { LoanStatusV2, LoanTermsV2 } from "./v2-codec";
import { audienceFor, auditorBody, requestBody, requestsInThread, sharedAuditors, v2LoanState } from "./v2-room-view";

const [lender, borrower, auditor, stranger] = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const NOW = 1_800_000_000;
const msg = (index: number, author: PublicKey, body: string): RoomMessage => ({ index, author, body, ts: NOW });

function loan(status: LoanStatusV2, startTs = NOW - 3600, auditorHash = new Uint8Array(32)): LoanTermsV2 {
  const terms: TermsV2 = { principal: 50_000_000n, interestBps: 200, duration: 14 * 86_400, startTs, earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 2500, graceSeconds: 86_400, lateFeeBps: 100, annualCeilingBps: 7000 };
  return {
    version: 2, originLender: lender, currentLender: lender, borrower, roomIndex: 2, requestIndex: 0, terms, collateralRequired: 1n, collateralLocked: 1n, maxLtvBps: 6000,
    liquidationLtvBps: 8000, revision: 1, fundedRevision: 1, acceptedRevision: 1, status, ledger: openLedger(terms), ledgerRevision: 0, shortfall: 0n, settledTs: 0,
    desk: auditorHash.some((b) => b) ? stranger : null, policyVersion: 1, auditorHash,
  };
}

test("borrowing requests round-trip through the thread with their message index", () => {
  const r = requestsInThread([msg(0, borrower, "hello"), msg(1, borrower, requestBody("12.5", 30)), msg(2, borrower, requestBody("100", 1))]);
  assert.deepEqual(r.map((x) => [x.index, x.principal, x.days]), [[1, 12_500_000n, 30], [2, 100_000_000n, 1]]);
  assert.ok(requestBody("1", 1).endsWith("1 day"));
});

test("only the lender's auditor notices for this loan count, and the borrower signs only a verified audience", () => {
  const t = loan("funded", 0, new Uint8Array(createHash("sha256").update(auditor.toBuffer()).digest()));
  const thread = [msg(0, stranger, auditorBody(2, stranger)), msg(1, lender, auditorBody(1, stranger)), msg(2, lender, auditorBody(2, auditor))];
  const shared = sharedAuditors(thread, t);
  assert.deepEqual(shared, [auditor.toBase58()]);
  const hash = new Uint8Array(createHash("sha256").update(Buffer.concat(shared.map((k) => new PublicKey(k).toBuffer()))).digest());
  assert.deepEqual(audienceFor(t, shared, hash), { kind: "named", auditors: [auditor.toBase58()] });
  assert.deepEqual(audienceFor(t, [], null), { kind: "unverified" });
  assert.deepEqual(audienceFor(t, [stranger.toBase58()], new Uint8Array(32).fill(1)), { kind: "unverified" });
  assert.deepEqual(audienceFor(loan("funded"), [], null), { kind: "none" });
});

test("each side sees its own next action", () => {
  assert.deepEqual(v2LoanState(loan("draft"), lender, NOW).actions, ["fund", "cancel"]);
  assert.deepEqual(v2LoanState(loan("funded"), borrower, NOW).actions, ["accept"]);
  const running = v2LoanState(loan("active"), borrower, NOW);
  assert.deepEqual(running.actions, ["repay", "top-up"]);
  assert.ok(running.payoff !== null && running.payoff > 50_000_000n);
  assert.deepEqual(v2LoanState(loan("active"), stranger, NOW).role, "reader");
});

test("recovery opens for the lender only at the right phase", () => {
  const start = NOW - 14 * 86_400 - 86_400 - 2 * 86_400; // two days past grace end: priced recovery is open
  const s = v2LoanState(loan("active", start), lender, NOW);
  assert.equal(s.phase, "PricedRecovery");
  assert.deepEqual(s.actions, ["claim-priced"]);
  const late = v2LoanState(loan("active", start - 7 * 86_400), lender, NOW);
  assert.deepEqual(late.actions, ["claim-priced", "claim-terminal"]);
});


test("full payoff remains a close after signing delay and across maturity", async () => {
  const { fullPayoffAmount } = await import("./v2-room-view");
  const { applyPayment, payoff } = await import("../loan-math-v2");
  const t = loan("active", NOW - 7 * 86_400);
  const cap = fullPayoffAmount(t, NOW);
  assert.ok(cap > payoff(t.terms, t.ledger, NOW));
  for (const delay of [1, 30, 120]) {
    const [, payment] = applyPayment(t.terms, t.ledger, NOW + delay, cap);
    assert.equal(payment.closed, true);
    assert.equal(payment.used, payoff(t.terms, t.ledger, NOW + delay));
  }
  const nearDue = t.terms.startTs + t.terms.duration - 60;
  const [, late] = applyPayment(t.terms, t.ledger, nearDue + 90, fullPayoffAmount(t, nearDue));
  assert.equal(late.closed, true);
  assert.ok(late.lateFee > 0n);
});

test("auditor revocation resumes from the audience still authorized on chain", async () => {
  const { resolveAudience } = await import("./v2-room-view");
  const keys = [auditor, stranger].map((k) => k.toBase58());
  const hash = async (ks: string[]) => new Uint8Array(createHash("sha256").update(Buffer.concat(ks.map((k) => new PublicKey(k).toBuffer()))).digest());
  const t = loan("active", NOW - 3600, await hash([keys[1]]));
  const thread = keys.map((k, i) => msg(i, lender, auditorBody(t.roomIndex, new PublicKey(k))));
  const original = sharedAuditors(thread, t);
  assert.deepEqual(await resolveAudience(t, original, hash), { kind: "named", auditors: [keys[1]] });
  assert.deepEqual(await resolveAudience({ ...t, status: "funded" }, original, hash), { kind: "unverified" });
  assert.deepEqual(await resolveAudience({ ...t, auditorHash: new Uint8Array(32) }, original, hash), { kind: "none" });
  assert.deepEqual(await resolveAudience({ ...t, auditorHash: await hash([borrower.toBase58()]) }, original, hash), { kind: "unverified" });
});
