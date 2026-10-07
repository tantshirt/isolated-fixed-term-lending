import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { EarlyRepayment, openLedger, type TermsV2 } from "../loan-math-v2";
import { deskLoanRow, deskOverview, policyRows, roleNames } from "./desk-view";
import type { DeskPolicyV2, DeskStateV2, LoanStatusV2, LoanTermsV2 } from "./v2-codec";

const [admin, lender, other, borrower, auditor] = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
const NOW = 1_800_000_000;
const DAY = 86_400;

function loan(status: LoanStatusV2, startTs: number, by = lender): LoanTermsV2 {
  const terms: TermsV2 = { principal: 100_000_000n, interestBps: 500, duration: 30 * DAY, startTs, earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 2500, graceSeconds: DAY, lateFeeBps: 100, annualCeilingBps: 7000 };
  return {
    version: 2, originLender: by, currentLender: by, borrower, roomIndex: 0, requestIndex: 0, terms, collateralRequired: 1n, collateralLocked: 1n,
    maxLtvBps: 6000, liquidationLtvBps: 8000, revision: 1, fundedRevision: 1, acceptedRevision: 1, status, ledger: openLedger(terms), ledgerRevision: 0,
    shortfall: 0n, settledTs: 0, desk: admin, policyVersion: 1, auditorHash: new Uint8Array(32),
  };
}

const state: DeskStateV2 = { version: 1, revision: 3n, policyVersion: 1, nextLoanSeq: 4, members: [{ pubkey: admin, roles: 1 }, { pubkey: lender, roles: 2 }, { pubkey: auditor, roles: 4 }] };

test("an administrator-only wallet has no lending role and sees unread loans as not shared", () => {
  assert.deepEqual(roleNames(1), ["admin"]);
  const rows = [deskLoanRow({ seq: 0, loan: other, terms: null }, admin, NOW)];
  const o = deskOverview(state, admin, rows);
  assert.equal(o.canAdminister, true);
  assert.equal(o.canLend, false);
  assert.equal(o.notShared, 1);
  assert.equal(o.running, 0);
});

test("past-due loans come first, sorted by the next deadline, and pending signatures are separate", () => {
  const rows = [
    deskLoanRow({ seq: 0, loan: Keypair.generate().publicKey, terms: loan("active", NOW - 10 * DAY) }, lender, NOW),
    deskLoanRow({ seq: 1, loan: Keypair.generate().publicKey, terms: loan("active", NOW - 30 * DAY - 3600) }, lender, NOW),
    deskLoanRow({ seq: 2, loan: Keypair.generate().publicKey, terms: loan("active", NOW - 28 * DAY) }, lender, NOW),
    deskLoanRow({ seq: 3, loan: Keypair.generate().publicKey, terms: loan("funded", 0) }, lender, NOW),
  ];
  const o = deskOverview(state, lender, rows);
  assert.deepEqual(o.urgent.map((r) => r.seq), [1, 2]);
  const first = o.urgent[0];
  assert.ok(first.access === "readable" && first.waiting === "In grace" && first.nextDeadline?.label === "Grace ends");
  assert.deepEqual(o.pending.map((r) => r.seq), [3]);
  assert.equal(o.running, 3);
  assert.equal(o.bookTotal, 300_000_000n);
});

test("every readable loan names its funding wallet, and payoff is only shown while running", () => {
  const r = deskLoanRow({ seq: 0, loan: other, terms: loan("active", NOW - DAY, other) }, lender, NOW);
  assert.ok(r.access === "readable");
  assert.ok(r.fundingWallet.equals(other));
  assert.equal(r.mine, false);
  assert.ok(r.payoff !== null && r.payoff > 100_000_000n);
  const repaid = deskLoanRow({ seq: 1, loan: other, terms: loan("repaid", NOW - DAY) }, lender, NOW);
  assert.ok(repaid.access === "readable" && repaid.payoff === null && repaid.waiting === null);
});

test("the policy reads in words with its auditor audience", () => {
  const p: DeskPolicyV2 = {
    version: 1, publishedAt: NOW, minPrincipal: 1_000_000n, maxPrincipal: 500_000_000n, minDurationSeconds: DAY, maxDurationSeconds: 90 * DAY,
    maxAnnualCeilingBps: 3000, maxInterestBps: 1000, repaymentModes: 2, maxLtvBps: 6500, maxLiquidationLtvBps: 8000, minGraceSeconds: DAY, maxLateFeeBps: 100, auditors: [auditor],
  };
  const rows = Object.fromEntries(policyRows(p));
  assert.equal(rows["Loan size"], "1 USDC to 500 USDC");
  assert.equal(rows["Term"], "1 day to 90 days");
  assert.equal(rows["Early repayment"], "Interest for days used");
  assert.match(rows["Auditors"], /^1 read-only/);
});

test("policy drafts are checked like the program checks them", async () => {
  const { DEFAULT_POLICY, policyDraftProblem } = await import("./desk-view");
  assert.equal(policyDraftProblem(DEFAULT_POLICY), null);
  assert.match(policyDraftProblem({ ...DEFAULT_POLICY, maxAnnualCeilingBps: 0 })!, /ceiling/);
  assert.match(policyDraftProblem({ ...DEFAULT_POLICY, repaymentModes: 0 })!, /early-repayment/);
  assert.match(policyDraftProblem({ ...DEFAULT_POLICY, minPrincipal: 2_000_000_000n })!, /smallest/);
  assert.match(policyDraftProblem({ ...DEFAULT_POLICY, minGraceSeconds: 3600 })!, /Grace/);
  assert.match(policyDraftProblem({ ...DEFAULT_POLICY, auditors: Array.from({ length: 5 }, () => auditor) })!, /at most 4/);
});

test("a running loan near its due date says so in words, and a moved position names its holder", () => {
  const near = deskLoanRow({ seq: 0, loan: other, terms: loan("active", NOW - 29 * DAY) }, lender, NOW);
  assert.ok(near.access === "readable" && near.waiting === "Due soon" && near.urgent);
  const moved = { ...loan("active", NOW - DAY), currentLender: other };
  const r = deskLoanRow({ seq: 1, loan: other, terms: moved }, lender, NOW);
  assert.ok(r.access === "readable" && r.mine && r.holder?.equals(other));
});
