import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { PrivateEndpointError, assertPrivateEndpoint, currentTeeSession, sessionMatchesWallet } from "./private/tee";

test("private requests only go to the attested TEE", () => {
  assertPrivateEndpoint("https://devnet-tee.magicblock.app?token=abc");
  for (const url of [
    "https://api.devnet.solana.com",
    "https://devnet-router.magicblock.app",
    "https://devnet-tee.magicblock.app.evil.example",
    "http://devnet-tee.magicblock.app",
  ]) {
    assert.throws(() => assertPrivateEndpoint(url), PrivateEndpointError, url);
  }
});

test("a private session cannot cross wallets or survive its expiry margin", () => {
  const session = { connection: {} as Connection, wallet: "alice", expiresAt: 120_000, attestedAt: 1 };
  assert.equal(sessionMatchesWallet(session, "alice", 1), true);
  assert.equal(sessionMatchesWallet(session, "bob", 1), false);
  assert.equal(sessionMatchesWallet(session, undefined, 1), false);
  assert.equal(sessionMatchesWallet(session, "alice", 60_000), false);
  assert.equal(sessionMatchesWallet({ ...session, expiresAt: NaN }, "alice", 1), false);
});

test("a stored attestation timestamp cannot authorize a restored connection", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: () => JSON.stringify({ token: "stored-token", expiresAt: Date.now() + 3600_000, attestedAt: Date.now() }),
    removeItem: () => {},
  } });
  try { assert.equal(currentTeeSession(PublicKey.default), null); }
  finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
