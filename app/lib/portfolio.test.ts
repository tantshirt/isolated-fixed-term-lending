import test from "node:test";
import assert from "node:assert/strict";
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DEVNET_USDC_MINT, NATIVE_WSOL_MINT } from "./constants";
import type { PriceSnapshot } from "./offer-status";
import { readOnlyProgram, type Offer } from "./offers";
import { OFFSETS, URGENCY, buildPortfolio, deadlineIcs, walletFilter } from "./portfolio";
import type { OfferAccount } from "./program";
import type { LoanRequest } from "./requests";

const me = Keypair.generate().publicKey.toBase58();
const other = Keypair.generate().publicKey.toBase58();
const NOW = 1_800_000_000;
const DAY = 86_400;

/** SOL/USD with Pyth's -8 exponent. */
const price = (usd: number): PriceSnapshot => ({
  price: BigInt(Math.round(usd * 1e8)),
  conf: 0n,
  exponent: -8,
  publishTime: NOW,
  fresh: true,
});

let seq = 0;
const offer = (over: Partial<Offer> = {}): Offer => ({
  publicKey: Keypair.generate().publicKey.toBase58(),
  lender: me,
  borrower: other,
  offerId: BigInt(++seq),
  usdcMint: DEVNET_USDC_MINT.toBase58(),
  wsolMint: NATIVE_WSOL_MINT.toBase58(),
  principal: 100_000_000n,
  interestBps: 500,
  durationSeconds: 7 * DAY,
  collateralAmount: 1_100_000_000n,
  maxLtvBps: 7000,
  liquidationLtvBps: 8000,
  startTs: NOW - DAY,
  expiryTs: NOW + 6 * DAY,
  status: "filled",
  ...over,
});

const request = (over: Partial<LoanRequest> = {}): LoanRequest => ({
  publicKey: Keypair.generate().publicKey.toBase58(),
  borrower: me,
  requestId: BigInt(++seq),
  usdcMint: DEVNET_USDC_MINT.toBase58(),
  wsolMint: NATIVE_WSOL_MINT.toBase58(),
  principal: 50_000_000n,
  interestBps: 400,
  durationSeconds: DAY,
  collateralAmount: 600_000_000n,
  maxLtvBps: 7000,
  liquidationLtvBps: 8000,
  createdTs: NOW - 100,
  status: "open",
  lender: null,
  offer: null,
  ...over,
});

test("wallet filters point at the lender and borrower bytes of an encoded offer", () => {
  const lender = Keypair.generate().publicKey;
  const borrower = Keypair.generate().publicKey;
  const account: OfferAccount = {
    lender,
    borrower,
    offerId: new BN(7),
    usdcMint: DEVNET_USDC_MINT,
    wsolMint: NATIVE_WSOL_MINT,
    principal: new BN(1),
    interestBps: 1,
    durationSeconds: new BN(60),
    collateralAmount: new BN(1),
    maxLtvBps: 7000,
    liquidationLtvBps: 8000,
    startTs: new BN(0),
    expiryTs: new BN(0),
    status: { open: {} },
    bump: 255,
  } as unknown as OfferAccount;
  return readOnlyProgram(new Connection("http://127.0.0.1:8899"))
    .coder.accounts.encode("offer", account)
    .then((data: Buffer) => {
      assert.deepEqual(data.subarray(OFFSETS.offerLender, OFFSETS.offerLender + 32), lender.toBuffer());
      assert.deepEqual(data.subarray(OFFSETS.offerBorrower, OFFSETS.offerBorrower + 32), borrower.toBuffer());
    });
});

test("walletFilter picks the right offset for each side", () => {
  const w = PublicKey.default.toBase58();
  assert.equal(walletFilter("offer", "lender", w).memcmp!.offset, 8);
  assert.equal(walletFilter("offer", "borrower", w).memcmp!.offset, 40);
  assert.equal(walletFilter("request", "borrower", w).memcmp!.offset, 8);
  assert.equal(walletFilter("request", "lender", w).memcmp!.offset, 151);
});

test("items are ordered past due, liquidatable, due soon, near the line, running, open, settled", () => {
  const { items } = buildPortfolio({
    me,
    price: price(150),
    now: NOW,
    requests: [request()],
    offers: [
      offer({ status: "repaid" }),
      offer({ status: "open", borrower: null }),
      offer(),
      offer({ expiryTs: NOW + 3_600 }),
      offer({ expiryTs: NOW - 1 }),
      offer({ collateralAmount: 900_000_000n }), // about 77.8% LTV at $150: near the line
      offer({ collateralAmount: 800_000_000n, lender: other, borrower: me }), // 87.5%: over the line
    ],
  });
  assert.deepEqual(
    items.map((i) => i.urgency),
    [URGENCY.pastDue, URGENCY.liquidatable, URGENCY.dueSoon, URGENCY.nearLine, URGENCY.running, URGENCY.open, URGENCY.open, URGENCY.settled]
  );
  assert.equal(items[0].action, "Claim collateral");
  assert.equal(items[1].side, "borrower");
  assert.equal(items[1].action, "Repay");
});

test("other people's offers and funded requests are left out", () => {
  const { items } = buildPortfolio({
    me,
    price: price(150),
    now: NOW,
    offers: [offer({ lender: other, borrower: Keypair.generate().publicKey.toBase58() })],
    requests: [request({ status: "funded", lender: other })],
  });
  assert.equal(items.length, 0);
});

test("totals add running loans by side and count what needs attention", () => {
  const { totals } = buildPortfolio({
    me,
    price: price(150),
    now: NOW,
    requests: [],
    offers: [
      offer(),
      offer({ expiryTs: NOW + 3_600 }),
      offer({ lender: other, borrower: me, principal: 200_000_000n, collateralAmount: 2_200_000_000n }),
      offer({ status: "open", borrower: null }),
    ],
  });
  assert.equal(totals.lentOut, 200_000_000n);
  assert.equal(totals.owedToYou, 210_000_000n);
  assert.equal(totals.borrowed, 200_000_000n);
  assert.equal(totals.youOwe, 210_000_000n);
  assert.equal(totals.nextDueTs, NOW + 3_600);
  assert.equal(totals.attention, 1);
});

test("without a price, running loans still sort by deadline", () => {
  const { items } = buildPortfolio({
    me,
    price: null,
    now: NOW,
    requests: [],
    offers: [offer({ expiryTs: NOW + 5 * DAY }), offer({ expiryTs: NOW + 2 * DAY })],
  });
  assert.deepEqual(items.map((i) => i.dueTs), [NOW + 2 * DAY, NOW + 5 * DAY]);
});

test("the calendar file ends exactly at the deadline", () => {
  const ics = deadlineIcs({ key: "k", side: "borrower", dueTs: NOW, owed: 105_000_000n }, "https://example.test/x")!;
  const end = new Date(NOW * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  assert.match(ics, new RegExp(`DTEND:${end}`));
  assert.match(ics, /SUMMARY:ZenLo: repay 105 USDC/);
  assert.equal(deadlineIcs({ key: "k", side: "lender", dueTs: null, owed: 1n }, "u"), null);
});
