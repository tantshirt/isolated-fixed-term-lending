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
