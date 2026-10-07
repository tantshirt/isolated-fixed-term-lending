import test from "node:test";
import assert from "node:assert/strict";
import { base58 as bs58 } from "@scure/base";
import nacl from "tweetnacl";
import { CHALLENGE_TTL_MS, challengeMessage, domainAllowed, isWalletAddress, newNonce, verifyChallenge, type Challenge } from "./siws";

const kp = nacl.sign.keyPair();
const wallet = bs58.encode(kp.publicKey);
const NOW = 1_800_000_000_000;

function challenge(over: Partial<Challenge> = {}): Challenge {
  return { domain: "zenlo.app", wallet, nonce: newNonce(), network: "devnet", issuedAt: NOW, expiresAt: NOW + CHALLENGE_TTL_MS, ...over };
}
const sign = (c: Challenge, secret = kp.secretKey) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(challengeMessage(c)), secret));

test("a fresh, correctly signed challenge verifies", () => {
  const c = challenge();
  assert.equal(verifyChallenge(c, { wallet, domain: "zenlo.app", signature: sign(c) }, NOW + 1000), null);
});

test("a used challenge is rejected even with a valid signature", () => {
  const c = challenge();
  assert.equal(verifyChallenge({ ...c, usedAt: NOW }, { wallet, domain: "zenlo.app", signature: sign(c) }, NOW + 1), "used");
});

test("an expired challenge is rejected at the exact expiry", () => {
  const c = challenge();
  assert.equal(verifyChallenge(c, { wallet, domain: "zenlo.app", signature: sign(c) }, c.expiresAt), "expired");
});

test("the wrong domain is rejected", () => {
  const c = challenge();
  assert.equal(verifyChallenge(c, { wallet, domain: "evil.app", signature: sign(c) }, NOW), "wrong-domain");
});

test("a signature from another wallet is rejected", () => {
  const c = challenge();
  const other = nacl.sign.keyPair();
  assert.equal(verifyChallenge(c, { wallet, domain: "zenlo.app", signature: sign(c, other.secretKey) }, NOW), "bad-signature");
  assert.equal(verifyChallenge(c, { wallet: bs58.encode(other.publicKey), domain: "zenlo.app", signature: sign(c, other.secretKey) }, NOW), "wrong-wallet");
});

test("a signature over a different nonce is rejected", () => {
  const c = challenge();
  const forged = sign({ ...c, nonce: newNonce() });
  assert.equal(verifyChallenge(c, { wallet, domain: "zenlo.app", signature: forged }, NOW), "bad-signature");
  assert.equal(verifyChallenge(c, { wallet, domain: "zenlo.app", signature: "not-base58!" }, NOW), "bad-signature");
});

test("domain allowlist supports exact hosts and preview patterns without crossing dots", () => {
  const allowed = ["zenlo.app", "localhost:3000", "zenlo-*-dres-projects.vercel.app"];
  assert.equal(domainAllowed("zenlo.app", allowed), true);
  assert.equal(domainAllowed("localhost:3000", allowed), true);
  assert.equal(domainAllowed("zenlo-git-desk-dres-projects.vercel.app", allowed), true);
  assert.equal(domainAllowed("zenlo-x.evil.com-dres-projects.vercel.app", allowed), false);
  assert.equal(domainAllowed("evil.zenlo.app", allowed), false);
  assert.equal(domainAllowed("zenlo.app/path", allowed), false);
});

test("wallet addresses must decode to 32 bytes", () => {
  assert.equal(isWalletAddress(wallet), true);
  assert.equal(isWalletAddress("abc"), false);
  assert.equal(isWalletAddress("0OIl"), false);
});

test("the message names the domain, network and expiry and says no funds move", () => {
  const m = challengeMessage(challenge());
  assert.match(m, /^zenlo\.app wants you to sign in/);
  assert.match(m, /does not move funds/);
  assert.match(m, /Network: devnet/);
  assert.match(m, /Expiration Time: /);
});
