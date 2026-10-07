import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { bandFor, parseIncome, tierFor, TIER_CAPS, CREDENTIAL_LIFETIME_SECONDS } from "./bands";
import { attestationPda, creditStatus, decodeCreditData, encodeAttestation, encodeCreditData, issuanceMessage, parseAttestation, SAS_PROGRAM_ID } from "./sas";
import { creditPilotEnabled } from "./flag";

test("income bands map to tiers at the documented floors", () => {
  assert.equal(bandFor(0), "below");
  assert.equal(bandFor(1_999.99), "below");
  assert.equal(bandFor(2_000), "entry");
  assert.equal(bandFor(4_999), "entry");
  assert.equal(bandFor(5_000), "middle");
  assert.equal(bandFor(9_999.99), "middle");
  assert.equal(bandFor(10_000), "upper");
  assert.equal(bandFor(Number.NaN), "below");
  assert.equal(tierFor("below"), null);
  assert.equal(tierFor("entry"), 1);
  assert.equal(tierFor("middle"), 2);
  assert.equal(tierFor("upper"), 3);
});

test("tier caps follow research: liquidation = max + 5, emergency = liquidation + 3", () => {
  assert.deepEqual([TIER_CAPS[1].maxLtvBps, TIER_CAPS[2].maxLtvBps, TIER_CAPS[3].maxLtvBps], [8_000, 8_500, 8_800]);
  for (const t of [1, 2, 3] as const) {
    assert.equal(TIER_CAPS[t].liquidationLtvBps, TIER_CAPS[t].maxLtvBps + 500);
    assert.equal(TIER_CAPS[t].emergencyLtvBps, TIER_CAPS[t].liquidationLtvBps + 300);
  }
});

test("required tier mirrors the program: standard, the lowest covering tier, or none", async () => {
  const { requiredTier } = await import("./bands");
  assert.equal(requiredTier(7_000, 8_500), 0);
  assert.equal(requiredTier(7_500, 8_500), 1);
  assert.equal(requiredTier(8_000, 8_600), 2);
  assert.equal(requiredTier(8_800, 9_300), 3);
  assert.equal(requiredTier(8_900, 9_300), null);
});

test("income parsing is strict and fails closed", () => {
  assert.equal(parseIncome("5000"), 5000);
  assert.equal(parseIncome("$12,500.50"), 12500.5);
  assert.equal(parseIncome(" 2,000 "), 2000);
  for (const bad of ["", "abc", "5,00", "1e6", "-3000", "5000.123", "12 000", null, 5000, undefined]) assert.equal(parseIncome(bad), null, String(bad));
});

test("the pilot flag accepts only 1 or true", () => {
  assert.equal(creditPilotEnabled("1"), true);
  assert.equal(creditPilotEnabled("true"), true);
  assert.equal(creditPilotEnabled(""), false);
  assert.equal(creditPilotEnabled(undefined), false);
  assert.equal(creditPilotEnabled("yes"), false);
});

const credential = Keypair.generate().publicKey.toBase58();
const schema = Keypair.generate().publicKey.toBase58();
const issuer = Keypair.generate().publicKey.toBase58();
const borrower = Keypair.generate().publicKey;
const expect_ = { credential, schema, issuer };
const NOW = 1_800_000_000;

function fixture(over: Partial<{ nonce: string; credential: string; schema: string; signer: string; expiry: number; data: Buffer }> = {}) {
  return encodeAttestation({
    nonce: borrower.toBase58(),
    credential,
    schema,
    signer: issuer,
    expiry: 0,
    tokenAccount: PublicKey.default.toBase58(),
    data: encodeCreditData(3, NOW + 1_000),
    ...over,
  });
}
const address = attestationPda(new PublicKey(credential), new PublicKey(schema), borrower).toBase58();
const SAS = SAS_PROGRAM_ID.toBase58();

test("attestation bytes round-trip in the SAS layout", () => {
  const raw = fixture();
  assert.equal(raw[0], 2);
  assert.equal(raw.length, 1 + 32 * 3 + 4 + 9 + 32 + 8 + 32);
  const a = parseAttestation(raw)!;
  assert.equal(a.nonce, borrower.toBase58());
  assert.equal(a.signer, issuer);
  assert.deepEqual(decodeCreditData(a.data), { tier: 3, expiry: NOW + 1_000 });
  assert.equal(parseAttestation(Buffer.from([1, ...raw.subarray(1)])), null);
  assert.equal(parseAttestation(raw.subarray(0, 120)), null);
});

test("a valid credential gives its tier; every bad one falls back to standard", () => {
  assert.deepEqual(creditStatus(SAS, address, fixture(), borrower.toBase58(), expect_, NOW), { state: "valid", tier: 3, expiry: NOW + 1_000 });
  assert.equal(creditStatus(null, address, null, borrower.toBase58(), expect_, NOW).state, "none"); // revoked = closed
  assert.equal(creditStatus(SAS, address, fixture(), borrower.toBase58(), expect_, NOW + 1_000).state, "expired");
  assert.equal(creditStatus(SAS, address, fixture({ expiry: NOW - 1 }), borrower.toBase58(), expect_, NOW).state, "expired");
  assert.equal(creditStatus(Keypair.generate().publicKey.toBase58(), address, fixture(), borrower.toBase58(), expect_, NOW).state, "invalid"); // wrong owner
  assert.equal(creditStatus(SAS, address, fixture({ signer: Keypair.generate().publicKey.toBase58() }), borrower.toBase58(), expect_, NOW).state, "invalid"); // wrong issuer
  assert.equal(creditStatus(SAS, address, fixture({ schema: Keypair.generate().publicKey.toBase58() }), borrower.toBase58(), expect_, NOW).state, "invalid"); // wrong schema
  assert.equal(creditStatus(SAS, address, fixture({ nonce: Keypair.generate().publicKey.toBase58() }), borrower.toBase58(), expect_, NOW).state, "invalid"); // wrong subject
  assert.equal(creditStatus(SAS, address, fixture({ data: encodeCreditData(1, NOW + 5).subarray(0, 8) }), borrower.toBase58(), expect_, NOW).state, "invalid");
  const tier4 = encodeCreditData(1, NOW + 5);
  tier4[0] = 4;
  assert.equal(creditStatus(SAS, address, fixture({ data: tier4 }), borrower.toBase58(), expect_, NOW).state, "invalid");
});

test("the issuance message is fixed, income-free and verifiable", () => {
  const kp = Keypair.generate();
  const fields = { subject: borrower.toBase58(), credential, schema, attestation: address, tier: 2 as const, expiry: NOW + CREDENTIAL_LIFETIME_SECONDS };
  const msg = issuanceMessage(fields);
  const text = new TextDecoder().decode(msg);
  assert.deepEqual(text.split("\n").map((l) => l.split(":")[0]), ["zenlo-credit-v1", "subject", "credential", "schema", "attestation", "tier", "expiry", "data"]);
  assert.doesNotMatch(text, /income/i);
  const sig = nacl.sign.detached(msg, kp.secretKey);
  assert.ok(nacl.sign.detached.verify(msg, sig, kp.publicKey.toBytes()));
});

test("a credential without a data expiry is never valid; an account expiry can only shorten it", async () => {
  const { effectiveExpiry } = await import("./sas");
  assert.equal(effectiveExpiry(0, 0), 0);
  assert.equal(effectiveExpiry(0, NOW + 10), 0);
  assert.equal(effectiveExpiry(NOW + 10, 0), NOW + 10);
  assert.equal(effectiveExpiry(NOW + 10, NOW + 5), NOW + 5);
  assert.equal(creditStatus(SAS, address, fixture({ data: encodeCreditData(2, 0) }), borrower.toBase58(), expect_, NOW).state, "expired");
});

test("the loan's tier is read from OfferV2.reserved[63] and only 1..3 count", async () => {
  const { creditTierOf, CREDIT_TIER_RESERVED_INDEX } = await import("../v2/offers");
  assert.equal(CREDIT_TIER_RESERVED_INDEX, 63);
  const r = new Array(64).fill(0);
  assert.equal(creditTierOf(r), 0);
  r[63] = 3;
  assert.equal(creditTierOf(r), 3);
  r[63] = 7;
  assert.equal(creditTierOf(r), 0);
  assert.equal(creditTierOf(undefined), 0);
});
