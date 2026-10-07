import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { EarlyRepayment, graceEnd, maturity, openLedger, payoff, type TermsV2 } from "../loan-math-v2";
import { v2LoanView } from "../models/loan-view";
import { REFINANCED_WORD } from "../phase-words";
import { LOAN_STATUS_V2 } from "../private/v2-codec";
import type { OfferV2 } from "./offers";
import { canRefinance, refinanceCandidates, refinanceQuote } from "./refinance";

const NOW = 1_800_000_000;
const DAY = 86_400;
const k = () => Keypair.generate().publicKey.toBase58();
const terms: TermsV2 = { principal: 100_000_000n, interestBps: 500, duration: 30 * DAY, startTs: NOW, earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 2500, graceSeconds: DAY, lateFeeBps: 100, annualCeilingBps: 10_000 };
const borrower = k();
const loan = (over: Partial<OfferV2> = {}): OfferV2 => ({
  generation: "v2", publicKey: k(), version: 2, originLender: k(), currentLender: k(), borrower, restrictedBorrower: null, offerId: 1n,
  usdcMint: "u", wsolMint: "w", terms, collateralRequired: 1_020_000_000n, collateralLocked: 1_020_000_000n, maxLtvBps: 7000,
  liquidationLtvBps: 8000, status: "active", ledger: openLedger(terms), shortfall: 0n, settledTs: 0, ...over,
});
const open = (principal: bigint, over: Partial<OfferV2> = {}) => loan({ borrower: null, status: "open", terms: { ...terms, principal, startTs: 0 }, ...over });

test("the old lender gets exactly the payoff: new principal plus the borrower's contribution", () => {
  const old = loan();
  const at = NOW + DAY;
  const q = refinanceQuote(old, open(90_000_000n), borrower, at);
  assert.equal(q.payoffOld, payoff(terms, old.ledger, at));
  assert.equal(q.payoffOld, 101_250_000n);
  assert.equal(q.newPrincipal + q.contribution, q.payoffOld);
  assert.equal(q.contribution, 11_250_000n);
  assert.equal(q.reason, null);
  const exact = refinanceQuote(old, open(101_250_000n), borrower, at);
  assert.equal(exact.contribution, 0n);
  assert.equal(exact.reason, null);
});

test("a new principal above the payoff is a cash-out and is rejected", () => {
  const q = refinanceQuote(loan(), open(101_250_001n), borrower, NOW + DAY);
  assert.match(q.reason!, /never pays cash out/);
});

test("only Active and Grace loans refinance", () => {
  const old = loan();
  assert.equal(canRefinance(old, maturity(terms) - 1), true);
  assert.equal(canRefinance(old, graceEnd(terms) - 1), true);
  assert.equal(canRefinance(old, graceEnd(terms)), false);
  assert.match(refinanceQuote(old, open(50_000_000n), borrower, graceEnd(terms)).reason!, /end of grace/);
  assert.equal(canRefinance(loan({ status: "refinanced" }), NOW), false);
});

test("a renewal offer restricted to another borrower is not a candidate", () => {
  const old = loan();
  const mine = open(100_000_000n, { restrictedBorrower: borrower });
  const theirs = open(100_000_000n, { restrictedBorrower: k() });
  const other = open(100_000_000n, { wsolMint: "jito" });
  const c = refinanceCandidates(old, [mine, theirs, other, old], borrower, NOW + DAY);
  assert.deepEqual(c.map((x) => x.offer.publicKey), [mine.publicKey]);
});

test("the loan view offers refinance to the borrower only before grace ends, behind the flag", () => {
  const can = (enabled: boolean, at: number) => v2LoanView(loan(), null, at, [], enabled).actions.find((a) => a.action === "refinance");
  assert.equal(can(true, NOW + DAY)?.available, true);
  assert.equal(can(true, NOW + DAY)?.by, "borrower");
  assert.equal(can(true, graceEnd(terms) - 1)?.available, true);
  assert.equal(can(true, graceEnd(terms))?.available, false);
  assert.match(can(false, NOW + DAY)!.reason!, /not enabled/);
  const paused = v2LoanView(loan(), null, NOW + DAY, [{ key: "originations", paused: true }], true).actions.find((a) => a.action === "refinance");
  assert.equal(paused?.available, false, "a refinance opens new exposure, so an originations pause stops it");
  assert.equal(v2LoanView(loan({ status: "refinanced" }), null, NOW, [], true).actions.find((a) => a.action === "refinance"), undefined);
});

test("Refinanced is its own terminal word, never Repaid", () => {
  assert.equal(REFINANCED_WORD, "Refinanced");
  assert.equal(LOAN_STATUS_V2[10], "refinanced");
});

 test("credit-tier replacement offers stay out of the pilot refinance picker", () => {
  const old = loan();
  const next = loan({ publicKey: "next", status: "open", maxLtvBps: 8_000, liquidationLtvBps: 8_500 });
  assert.match(refinanceQuote(old, next, old.borrower!, NOW + DAY).reason!, /Credit-tier/);
  assert.deepEqual(refinanceCandidates(old, [next], old.borrower!, NOW + DAY), []);
});
