import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { arciumEnabled, CREDIT_MXE_ID, decodeTierResult, MAX_ATTESTATION_AGE_SECONDS, TIER_RESULT_DISCRIMINATOR, TIER_RESULT_LEN, tierResultPda, tierStatus } from "./arcium";
import { capabilityFor, WSOL } from "../capabilities";

const NOW = 1_800_000_000;

/** TierResult bytes in the layout of credit_tier::tier_offsets. */
function bytes(borrower: PublicKey, tier: number, computedAt: number, attestedAt: number, incomeValidUntil: number, pending = false) {
  const b = Buffer.alloc(TIER_RESULT_LEN);
  TIER_RESULT_DISCRIMINATOR.copy(b, 0);
  b[8] = 1;
  borrower.toBuffer().copy(b, 9);
  b[41] = tier;
  b.writeBigInt64LE(BigInt(computedAt), 50);
  b.writeBigInt64LE(BigInt(attestedAt), 66);
  b.writeBigInt64LE(BigInt(incomeValidUntil), 74);
  b[82] = pending ? 1 : 0;
  return b;
}

test("discriminator and PDA match the program", () => {
  assert.deepEqual(TIER_RESULT_DISCRIMINATOR, createHash("sha256").update("account:TierResult").digest().subarray(0, 8));
  const w = Keypair.generate().publicKey;
  assert.equal(tierResultPda(w).toBase58(), PublicKey.findProgramAddressSync([Buffer.from("arcium-tier"), w.toBuffer()], CREDIT_MXE_ID)[0].toBase58());
});

test("a fresh tier is valid; stale, expired, foreign, low or never-computed results are not", () => {
  const w = Keypair.generate().publicKey;
  const me = w.toBase58();
  const ok = tierStatus(decodeTierResult(bytes(w, 3, NOW - 10, NOW - 60, NOW + 86_400)), me, NOW);
  assert.equal(ok.state, "valid");
  if (ok.state === "valid") assert.equal(ok.validUntil, NOW + 86_400);
  assert.equal(tierStatus(decodeTierResult(bytes(w, 3, NOW - 10, NOW - MAX_ATTESTATION_AGE_SECONDS - 1, NOW + 86_400)), me, NOW).state, "unusable");
  assert.equal(tierStatus(decodeTierResult(bytes(w, 3, NOW - 10, NOW - 60, NOW)), me, NOW).state, "unusable");
  assert.equal(tierStatus(decodeTierResult(bytes(w, 0, NOW - 10, NOW - 60, NOW + 86_400)), me, NOW).state, "unusable");
  assert.equal(tierStatus(decodeTierResult(bytes(w, 3, NOW - 10, NOW - 60, NOW + 86_400)), Keypair.generate().publicKey.toBase58(), NOW).state, "unusable");
  assert.equal(tierStatus(decodeTierResult(bytes(w, 0, 0, 0, 0, true)), me, NOW).state, "pending");
  assert.equal(tierStatus(decodeTierResult(bytes(w, 0, 0, 0, 0)), me, NOW).state, "none");
  const bad = bytes(w, 3, NOW - 10, NOW - 60, NOW + 86_400);
  bad[0] ^= 1;
  assert.equal(decodeTierResult(bad), null);
  assert.equal(decodeTierResult(bytes(w, 3, 1, 1, 1).subarray(0, TIER_RESULT_LEN - 1)), null);
});

test("the Arcium option is off unless the flag and the credit pilot are on", () => {
  assert.equal(arciumEnabled(undefined), false);
  assert.equal(arciumEnabled("1"), true);
  assert.equal(arciumEnabled("true"), true);
  assert.equal(arciumEnabled("yes"), false);
  // Neither flag is set in the test environment.
  assert.equal(capabilityFor("arcium", "devnet", WSOL, "credential").available, false);
});

test("a cached result stops granting a tier when the clock reaches credential expiry", () => {
  const wallet = Keypair.generate().publicKey;
  const result = decodeTierResult(bytes(wallet, 2, NOW - 10, NOW - 60, NOW + 5))!;
  assert.equal(tierStatus(result, wallet.toBase58(), NOW + 4).state, "valid");
  assert.equal(tierStatus(result, wallet.toBase58(), NOW + 5).state, "unusable");
  assert.equal(tierStatus(result, Keypair.generate().publicKey.toBase58(), NOW).state, "unusable");
});
