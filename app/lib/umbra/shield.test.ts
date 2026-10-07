import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, capabilityFor, DEVNET_USDC, WSOL } from "../capabilities";
import { balanceWords, callbackWords, parseWsolAmount, shieldErrorMessage, subscriptionsUrl } from "./shield";

test("Umbra shields wSOL only behind the deployment flag; USDC stays unavailable", () => {
  const row = CAPABILITIES.find((c) => c.provider === "umbra" && c.mint === WSOL && c.operation === "shield");
  assert.ok(row);
  assert.equal(row.available, process.env.NEXT_PUBLIC_UMBRA_ENABLED === "1");
  const usdc = capabilityFor("umbra", "devnet", DEVNET_USDC, "shield");
  assert.deepEqual(usdc, { available: false, reason: "Umbra's Devnet supports wSOL only.", simulationOnly: false });
  assert.equal(capabilityFor("umbra", "mainnet", WSOL, "shield").available, false);
});

test("Privacy Cash is blocked with its reason on every mint", () => {
  for (const mint of [WSOL, DEVNET_USDC]) {
    const c = capabilityFor("privacy-cash", "devnet", mint, "shield");
    assert.equal(c.available, false);
    assert.ok(!c.available && c.reason === "Privacy Cash has no public Devnet relayer, and its official SDK is mainnet-only.");
  }
});

test("the env flag turns the Umbra wSOL row on only when exactly 1", async () => {
  const prev = process.env.NEXT_PUBLIC_UMBRA_ENABLED;
  try {
    for (const [value, on] of [["1", true], ["true", false], ["", false]] as const) {
      process.env.NEXT_PUBLIC_UMBRA_ENABLED = value;
      const mod = await import(`../capabilities?flag=${value || "empty"}`);
      assert.equal(mod.capabilityFor("umbra", "devnet", WSOL, "shield").available, on, value);
    }
  } finally {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_UMBRA_ENABLED;
    else process.env.NEXT_PUBLIC_UMBRA_ENABLED = prev;
  }
});

test("wSOL amounts convert to lamports exactly", () => {
  assert.deepEqual(parseWsolAmount("1", null), { ok: true, lamports: 1_000_000_000n });
  assert.deepEqual(parseWsolAmount("0.000000001", null), { ok: true, lamports: 1n });
  assert.deepEqual(parseWsolAmount("1,234.5", null), { ok: true, lamports: 1_234_500_000_000n });
  assert.deepEqual(parseWsolAmount(".25", null), { ok: true, lamports: 250_000_000n });
  assert.equal(parseWsolAmount("0.0000000001", null).ok, false);
  assert.equal(parseWsolAmount("0", null).ok, false);
  assert.equal(parseWsolAmount("", null).ok, false);
  assert.equal(parseWsolAmount("1.2.3", null).ok, false);
  assert.equal(parseWsolAmount("-1", null).ok, false);
  assert.deepEqual(parseWsolAmount("2", 1_000_000_000n), { ok: false, reason: "That is more than you have." });
  assert.equal(parseWsolAmount("1", 1_000_000_000n).ok, true);
});

test("errors map to plain words and never echo SDK text", () => {
  assert.equal(shieldErrorMessage(new Error("User rejected the request.")), "You cancelled in your wallet. Nothing moved.");
  assert.match(shieldErrorMessage(new Error("Transaction simulation failed: insufficient lamports")), /isn't enough/);
  assert.match(shieldErrorMessage(new Error("block height exceeded: blockhash expired")), /expired/);
  assert.match(shieldErrorMessage(new TypeError("Failed to fetch")), /Couldn't reach/);
  assert.match(shieldErrorMessage(new Error("Wallet does not support feature solana:signMessage")), /can't sign the message/);
  const odd = shieldErrorMessage(new Error("RescueCipher panic at 0xdeadbeef"));
  assert.doesNotMatch(odd, /Rescue|0xdeadbeef/);
});

test("callback and balance states are explained", () => {
  assert.equal(callbackWords("shield", "finalized"), "Shielded.");
  assert.equal(callbackWords("unshield", undefined), "Unshielded to your wallet.");
  assert.match(callbackWords("shield", "timed-out"), /Recover shielded balance/);
  assert.match(callbackWords("unshield", "pruned"), /dropped/);
  assert.deepEqual(balanceWords({ state: "shared", balance: 5n }).lamports, 5n);
  assert.equal(balanceWords({ state: "non_existent" }).lamports, 0n);
  assert.equal(balanceWords({ state: "mxe" }).lamports, null);
  assert.equal(balanceWords(null).lamports, null);
});

test("subscription URL follows the RPC scheme unless a WebSocket URL is set", () => {
  assert.equal(subscriptionsUrl("https://api.devnet.solana.com"), "wss://api.devnet.solana.com");
  assert.equal(subscriptionsUrl("http://127.0.0.1:8899"), "ws://127.0.0.1:8899");
  assert.equal(subscriptionsUrl("https://x", "wss://y"), "wss://y");
});
