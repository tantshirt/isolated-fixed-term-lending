import test from "node:test";
import assert from "node:assert/strict";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { decodeOfferV2 } from "./offers";
import { offerV2Pda, PROGRAM_V2_ID, v2Coder, wsolVaultV2Pda, OFFER_V2_OFFSETS } from "./program";
import { EarlyRepayment } from "../loan-math-v2";

const k = () => Keypair.generate().publicKey;

test("OfferV2 decodes with exact integers and nullable keys", async () => {
  const lender = k();
  const borrower = k();
  const raw = {
    version: 2,
    originLender: lender,
    currentLender: lender,
    borrower,
    restrictedBorrower: PublicKey.default,
    offerId: new BN("18446744073709551615"),
    usdcMint: k(),
    wsolMint: k(),
    terms: { principal: new BN(100_000_000), interestBps: 500, duration: new BN(2_592_000), earlyRepayment: 1, minInterestBps: 2500, graceSeconds: new BN(86_400), lateFeeBps: 100, annualCeilingBps: 10_000, startTs: new BN(1_700_000_000) },
    collateralRequired: new BN(1_020_000_000),
    collateralLocked: new BN(1_520_000_000),
    maxLtvBps: 7000,
    liquidationLtvBps: 8000,
    status: { active: {} },
    ledger: { outstandingPrincipal: new BN(71_666_666), interestAccrued: new BN(3), interestPaid: new BN(1_666_666), accrualRemainder: new BN("123456789012345678901"), lastAccrualTs: new BN(1_700_864_000), lateFeeAssessed: new BN(0), lateFeePaid: new BN(0), lateFeeChecked: false },
    shortfall: new BN(0),
    settledTs: new BN(0),
    bump: 254,
    reserved: Array(64).fill(0),
  };
  const data = await v2Coder.encode("offerV2", raw);
  const pk = offerV2Pda(lender, 7n);
  const o = decodeOfferV2(pk, data);
  assert.equal(o.status, "active");
  assert.equal(o.offerId, 18446744073709551615n);
  assert.equal(o.restrictedBorrower, null);
  assert.equal(o.borrower, borrower.toBase58());
  assert.equal(o.terms.earlyRepayment, EarlyRepayment.ProRata);
  assert.equal(o.ledger.accrualRemainder, 123456789012345678901n);
  assert.equal(o.collateralLocked, 1_520_000_000n);
  // The memcmp offsets used for wallet filters point at the right keys.
  assert.equal(new PublicKey(data.subarray(OFFER_V2_OFFSETS.originLender, OFFER_V2_OFFSETS.originLender + 32)).toBase58(), lender.toBase58());
  assert.equal(new PublicKey(data.subarray(OFFER_V2_OFFSETS.borrower, OFFER_V2_OFFSETS.borrower + 32)).toBase58(), borrower.toBase58());
});

test("V2 PDAs differ from V1 seeds and from each other", () => {
  const lender = k();
  const offer = offerV2Pda(lender, 1n);
  assert.notEqual(offer.toBase58(), wsolVaultV2Pda(offer).toBase58());
  assert.equal(PublicKey.findProgramAddressSync([Buffer.from("offer-v2"), lender.toBuffer(), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])], PROGRAM_V2_ID)[0].toBase58(), offer.toBase58());
});
