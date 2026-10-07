import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { buyBlocker, canList, listingState, positionPaidSnapshot, RESALE_NOTICE, type Listing } from "./market";
import { EarlyRepayment, graceEnd, maturity, openLedger, type TermsV2 } from "../loan-math-v2";
import type { OfferV2 } from "./offers";
import { capabilityFor, DEVNET_USDC } from "../capabilities";

const NOW = 1_800_000_000;
const k = () => Keypair.generate().publicKey.toBase58();
const terms: TermsV2 = { principal: 10_000_000n, interestBps: 500, duration: 30 * 86_400, startTs: NOW, earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 2500, graceSeconds: 86_400, lateFeeBps: 100, annualCeilingBps: 10_000 };
const seller = k();
const offer = (over: Partial<OfferV2> = {}): OfferV2 => ({
  generation: "v2", publicKey: k(), version: 2, originLender: seller, currentLender: seller, borrower: k(), restrictedBorrower: null, offerId: 1n, usdcMint: "u", wsolMint: "w",
  terms, collateralRequired: 1n, collateralLocked: 1n, maxLtvBps: 7000, liquidationLtvBps: 8000, status: "active", ledger: openLedger(terms), shortfall: 0n, settledTs: 0, ...over,
});
const listing = (over: Partial<Listing> = {}): Listing => ({ publicKey: k(), offer: k(), seller, price: 9_000_000n, expiry: NOW + 10 * 86_400, ...over });

test("a listing is buyable only while the seller holds an Active or Grace loan before expiry", () => {
  const o = offer();
  assert.equal(listingState(listing(), o, NOW + 1), "buyable");
  assert.equal(listingState(listing({ expiry: graceEnd(terms) + 10 }), o, maturity(terms)), "buyable", "grace is sellable");
  assert.equal(listingState(listing({ expiry: graceEnd(terms) + 10 }), o, graceEnd(terms)), "settled", "overdue is not");
  assert.equal(listingState(listing(), o, NOW + 10 * 86_400), "expired", "expiry is exclusive");
  assert.equal(listingState(listing(), offer({ currentLender: k() }), NOW + 1), "stale");
  assert.equal(listingState(listing(), offer({ status: "repaid" }), NOW + 1), "settled");
  assert.equal(listingState(listing(), null, NOW + 1), "settled", "a closed loan voids its listing");
});

test("only the current lender lists, and the borrower and seller cannot buy", () => {
  const o = offer();
  assert.equal(canList(o, seller, NOW + 1), true);
  assert.equal(canList(o, k(), NOW + 1), false);
  assert.equal(canList(o, null, NOW + 1), false);
  assert.equal(canList(o, seller, graceEnd(terms)), false);
  assert.equal(canList(offer({ status: "repaid" }), seller, NOW + 1), false);
  assert.equal(buyBlocker(listing(), o, k(), NOW + 1), null);
  assert.ok(buyBlocker(listing(), o, o.borrower!, NOW + 1));
  assert.ok(buyBlocker(listing(), o, seller, NOW + 1));
  assert.equal(RESALE_NOTICE, "This position may be sold. Payments then go to the new holder.");
});

test("selling and export follow their deployment flags", () => {
  const on = process.env.NEXT_PUBLIC_SECONDARY_MARKET_ENABLED === "1";
  assert.equal(capabilityFor("zenlo-public", "devnet", DEVNET_USDC, "resell").available, on);
  assert.equal(capabilityFor("zenlo-private", "devnet", DEVNET_USDC, "resell").available, on);
  assert.equal(capabilityFor("zenlo-public", "devnet", "any-mint", "export").available, process.env.NEXT_PUBLIC_EXPORT_ENABLED === "1");
});


test("purchase snapshot detects principal, interest-only and late-fee payments but permits accrual", () => {
  const o = offer();
  const snapshot = positionPaidSnapshot(o);
  assert.equal(snapshot, 0n);
  const ledger = o.ledger;
  assert.equal(positionPaidSnapshot({ ...o, ledger: { ...ledger, interestAccrued: 200n, lastAccrualTs: NOW + 1 } }), snapshot);
  assert.equal(positionPaidSnapshot({ ...o, ledger: { ...ledger, interestPaid: 1n } }), 1n);
  assert.equal(positionPaidSnapshot({ ...o, ledger: { ...ledger, lateFeePaid: 1n } }), 1n);
  assert.equal(positionPaidSnapshot({ ...o, ledger: { ...ledger, outstandingPrincipal: ledger.outstandingPrincipal - 1n } }), 1n);
  const max = (1n << 64n) - 1n;
  assert.equal(positionPaidSnapshot({ ...o, terms: { ...terms, principal: max }, ledger: { ...ledger, outstandingPrincipal: 0n, interestPaid: max, lateFeePaid: max } }), 3n * max, "sum must not truncate to u64");
});

test("market IDLs require the signed payment snapshot or private ledger revision", async () => {
  const { BorshInstructionCoder, BN } = await import("@coral-xyz/anchor");
  const publicIdl = (await import("../../idl/isolated_loan_v2.json")).default;
  const privateIdl = (await import("../../idl/private_loan_v2.json")).default;
  const coder = new BorshInstructionCoder(publicIdl as never);
  const expectedPaid = 1n << 65n;
  const bytes = coder.encode("buy_position", { expected_price: new BN(1), expected_paid: new BN(expectedPaid.toString()) });
  const decoded = coder.decode(bytes)!.data as { expected_paid: { toString(): string } };
  assert.equal(decoded.expected_paid.toString(), expectedPaid.toString());
  const transfer = privateIdl.instructions.find((ix) => ix.name === "transfer_position")!;
  assert.deepEqual(transfer.args.at(-1), { name: "expected_ledger_revision", type: "u32" });
});
