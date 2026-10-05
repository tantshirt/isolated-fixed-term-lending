import {
  assertWorkedExample,
  collateralValueUsdc,
  debt,
  interest,
  currentLtvBps,
  seizeUsdc,
  wsolToCaller,
} from "../../app/lib/loan-math";
import { offerPda, usdcVaultPda, wsolVaultPda } from "../../app/lib/pda";
import { PublicKey } from "@solana/web3.js";
import assert from "node:assert";
import { readFileSync } from "node:fs";

assertWorkedExample();

// Same file the Rust tests in crates/loan-core read.
const vectors = JSON.parse(
  readFileSync(new URL("../crates/loan-core/vectors.json", import.meta.url), "utf8"),
);
for (const c of vectors.interest) {
  assert.equal(interest(BigInt(c.principal), c.interest_bps), BigInt(c.interest));
  assert.equal(debt(BigInt(c.principal), c.interest_bps), BigInt(c.debt));
}
for (const c of vectors.collateral_value) {
  const got = collateralValueUsdc(BigInt(c.lamports), BigInt(c.price), BigInt(c.conf), c.exponent);
  assert.equal(got, BigInt(c.value));
}
for (const c of vectors.ltv) {
  assert.equal(currentLtvBps(BigInt(c.debt), BigInt(c.value)), c.ltv_bps);
}
for (const c of vectors.seize) {
  assert.equal(seizeUsdc(BigInt(c.debt)), BigInt(c.seize));
}
for (const c of vectors.wsol_to_caller) {
  assert.equal(wsolToCaller(BigInt(c.lamports), BigInt(c.seize), BigInt(c.value)), BigInt(c.to_caller));
}

const lender = PublicKey.unique();
const offerId = 42n;
const offer = offerPda(lender, offerId);
const usdc = usdcVaultPda(offer);
const wsol = wsolVaultPda(offer);
assert.notEqual(offer.toBase58(), usdc.toBase58());
assert.notEqual(offer.toBase58(), wsol.toBase58());

console.log("loan-math and PDA checks passed");
