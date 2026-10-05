import assert from "node:assert/strict";
import { test } from "node:test";
import { PrivateEndpointError, assertPrivateEndpoint } from "./private/tee";

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
