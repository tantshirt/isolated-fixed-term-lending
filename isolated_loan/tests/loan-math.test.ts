import {
  assertWorkedExample,
  collateralValueUsdc,
  currentLtvBps,
  seizeUsdc,
  wsolToCaller,
} from "../../app/lib/loan-math";
import { offerPda, usdcVaultPda, wsolVaultPda } from "../../app/lib/pda";
import { PublicKey } from "@solana/web3.js";
import assert from "node:assert";

assertWorkedExample();

// Same vectors as the Rust unit tests in state.rs.
const minValue = collateralValueUsdc(1_001_001_002n, 15_000_000_000n, 15_000_000n, -8);
assert.equal(minValue, 150_000_000n);
assert.equal(currentLtvBps(105_000_000n, minValue), 7000);
assert.equal(seizeUsdc(105_000_000n), 110_250_000n);
assert.equal(currentLtvBps(105_000_000n, 1_000_000n), 65_535);
assert.equal(currentLtvBps(105_000_000n, 0n), 65_535);
assert.equal(wsolToCaller(1_000n, 110_250_000n, 50_000_000n), 1_000n);

const lender = PublicKey.unique();
const offerId = 42n;
const offer = offerPda(lender, offerId);
const usdc = usdcVaultPda(offer);
const wsol = wsolVaultPda(offer);
assert.notEqual(offer.toBase58(), usdc.toBase58());
assert.notEqual(offer.toBase58(), wsol.toBase58());

console.log("loan-math and PDA checks passed");
