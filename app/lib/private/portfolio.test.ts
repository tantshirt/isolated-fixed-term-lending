import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { privatePositions, privateTotals } from "./portfolio";
import type { LoanTerms } from "./loan-codec";
import type { MyRoom } from "./inbox";

const me = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const room = { roomId: "r", anchor: Keypair.generate().publicKey, state: { owner: me, revision: 0n, members: [] }, role: "lender", owner: true } as MyRoom;
const terms = (over: Partial<LoanTerms>): LoanTerms => ({
  lender: me, borrower: other, principal: 100_000_000n, interestBps: 500, durationSeconds: 86_400, collateralAmount: 1n, maxLtvBps: 7000,
  liquidationLtvBps: 8000, revision: 1, fundedRevision: 1, acceptedRevision: 1, status: "active", startTs: 0, expiryTs: 1, ...over,
});
const loan = (t: LoanTerms | null) => ({ anchor: Keypair.generate().publicKey as PublicKey, loanId: "x", terms: t });

test("private positions keep only loans where the wallet is a party", () => {
  const p = privatePositions(me, [{ room, loans: [loan(terms({})), loan(terms({ lender: other, borrower: me })), loan(terms({ lender: other, borrower: Keypair.generate().publicKey })), loan(null)] }]);
  assert.deepEqual(p.map((x) => x.side), ["lender", "borrower"]);
});

test("private totals count running loans only and flag offers waiting for the borrower", () => {
  const p = privatePositions(me, [
    {
      room,
      loans: [
        loan(terms({})),
        loan(terms({ status: "repaid" })),
        loan(terms({ lender: other, borrower: me })),
        loan(terms({ lender: other, borrower: me, status: "funded" })),
      ],
    },
  ]);
  const t = privateTotals(p);
  assert.equal(t.lentOut, 100_000_000n);
  assert.equal(t.owedToYou, 105_000_000n);
  assert.equal(t.borrowed, 100_000_000n);
  assert.equal(t.youOwe, 105_000_000n);
  assert.equal(t.waitingForYou, 1);
});

test("V2 private totals use outstanding principal and today's payoff, and add to V1 totals", async () => {
  const { privateV2Positions, privateV2Totals, addTotals } = await import("./portfolio");
  const { EarlyRepayment, openLedger } = await import("../loan-math-v2");
  const tv2 = { principal: 100_000_000n, interestBps: 500, duration: 30 * 86_400, startTs: 1_000, earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 2500, graceSeconds: 86_400, lateFeeBps: 100, annualCeilingBps: 7000 };
  const v2 = (status: "active" | "funded", lender: PublicKey, borrower: PublicKey) => ({
    version: 2, originLender: lender, currentLender: lender, borrower, roomIndex: 0, requestIndex: 0, terms: tv2, collateralRequired: 1n, collateralLocked: 1n,
    maxLtvBps: 6000, liquidationLtvBps: 8000, revision: 1, fundedRevision: 1, acceptedRevision: 1, status, ledger: { ...openLedger(tv2), outstandingPrincipal: 60_000_000n },
    ledgerRevision: 0, shortfall: 0n, settledTs: 0, desk: null, policyVersion: 0, auditorHash: new Uint8Array(32),
  });
  const pos = privateV2Positions(me, [{ room: { creator: "c", roomId: "r" }, loans: [
    { index: 0, anchor: Keypair.generate().publicKey, terms: v2("active", me, other) as never },
    { index: 1, anchor: Keypair.generate().publicKey, terms: v2("funded", other, me) as never },
    { index: 2, anchor: Keypair.generate().publicKey, terms: null },
  ] }]);
  assert.deepEqual(pos.map((p) => p.side), ["lender", "borrower"]);
  const t = privateV2Totals(pos, 1_000 + 86_400);
  assert.equal(t.lentOut, 60_000_000n);
  assert.ok(t.owedToYou > 60_000_000n);
  assert.equal(t.waitingForYou, 1);
  const sum = addTotals(t, privateTotals([]));
  assert.equal(sum.lentOut, 60_000_000n);
});
