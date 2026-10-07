import test from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { base58 } from "@scure/base";
import { RAMPS, parseSignatureHeader, reviewSignPayload, strkeyToEd25519, toBaseUnits, verifyWebhook, CASH_OUT_TERMINAL } from "./moneygram";

/** Encodes a raw Ed25519 key as a G... strkey (version byte 6 << 3, CRC16-XModem), for tests. */
function toStrkey(raw: Uint8Array): string {
  const payload = Uint8Array.from([6 << 3, ...raw]);
  let crc = 0;
  for (const b of payload) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  const all = Uint8Array.from([...payload, crc & 0xff, crc >> 8]);
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const b of all) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

const kp = nacl.sign.keyPair();
const key = toStrkey(kp.publicKey);
const host = "zenlo-123.convex.site";
const NOW = 1_800_000_000_000;
const message = JSON.stringify({ transaction: { id: "bb7f5271", network: "SOL", kind: "withdrawal", status: "completed", amount_in: "6.66" } });
const signed = (t: number, msg = message, k = kp.secretKey) => `t=${t},s=${Buffer.from(nacl.sign.detached(new TextEncoder().encode(`${t}.${host}.${msg}`), k)).toString("base64")}`;
const body = (msg = message) => JSON.stringify({ message: msg });

test("published webhook keys decode to 32-byte Ed25519 keys", () => {
  assert.equal(strkeyToEd25519(RAMPS.sandbox.webhookKey).length, 32);
  assert.equal(strkeyToEd25519(RAMPS.production.webhookKey).length, 32);
  assert.deepEqual(strkeyToEd25519(key), kp.publicKey);
});

test("the signature header splits on the first '=' so base64 padding survives", () => {
  assert.deepEqual(parseSignatureHeader("t=1787932754,s=abc=="), { t: "1787932754", s: "abc==" });
  assert.equal(parseSignatureHeader(null), null);
  assert.equal(parseSignatureHeader("t=1"), null);
});

test("a genuine notification verifies, including a retry 64 minutes later", () => {
  const t = NOW / 1000;
  const r = verifyWebhook({ signature: signed(t), rawBody: body(), host, webhookKey: key, now: NOW });
  assert.equal(r.ok && r.transaction.status, "completed");
  assert.equal(verifyWebhook({ signature: signed(t), rawBody: body(), host, webhookKey: key, now: NOW + 64 * 60_000 }).ok, true);
});

test("forged, re-serialized, wrong-host and stale notifications are refused", () => {
  const t = NOW / 1000;
  const other = nacl.sign.keyPair();
  assert.deepEqual(verifyWebhook({ signature: signed(t, message, other.secretKey), rawBody: body(), host, webhookKey: key, now: NOW }), { ok: false, reason: "bad-signature" });
  const reserialized = JSON.stringify(JSON.parse(message), null, 1);
  assert.deepEqual(verifyWebhook({ signature: signed(t), rawBody: body(reserialized), host, webhookKey: key, now: NOW }), { ok: false, reason: "bad-signature" });
  assert.deepEqual(verifyWebhook({ signature: signed(t), rawBody: body(), host: "evil.example", webhookKey: key, now: NOW }), { ok: false, reason: "bad-signature" });
  assert.deepEqual(verifyWebhook({ signature: signed(t), rawBody: body(), host, webhookKey: key, now: NOW + 66 * 60_000 }), { ok: false, reason: "stale" });
  assert.deepEqual(verifyWebhook({ signature: signed(t + 600), rawBody: body(), host, webhookKey: key, now: NOW }), { ok: false, reason: "stale" });
  assert.deepEqual(verifyWebhook({ signature: null, rawBody: body(), host, webhookKey: key, now: NOW }), { ok: false, reason: "no-signature" });
  assert.deepEqual(verifyWebhook({ signature: signed(t), rawBody: "not json", host, webhookKey: key, now: NOW }), { ok: false, reason: "bad-body" });
});

const to = base58.encode(nacl.sign.keyPair().publicKey);
const good = { chain: "solana", to, amount: "10.5", asset: "USDC", requiredNetwork: "testnet" as const, tokenAddress: RAMPS.sandbox.usdcMint, tokenDecimals: 6 };

test("the transfer MoneyGram asks for is reviewed before the wallet is asked", () => {
  const r = reviewSignPayload(good, "sandbox", 20_000_000n);
  assert.equal(r.ok && r.transfer.atoms, 10_500_000n);
  const reason = (x: ReturnType<typeof reviewSignPayload>) => (x.ok ? "" : x.reason);
  assert.match(reason(reviewSignPayload({ ...good, requiredNetwork: "mainnet" }, "sandbox", 20_000_000n)), /Devnet/);
  assert.match(reason(reviewSignPayload({ ...good, tokenAddress: RAMPS.production.usdcMint }, "sandbox", 20_000_000n)), /mint/);
  assert.match(reason(reviewSignPayload({ ...good, tokenDecimals: 9 }, "sandbox", 20_000_000n)), /decimals/);
  assert.match(reason(reviewSignPayload({ ...good, to: "not-an-address" }, "sandbox", 20_000_000n)), /Solana address/);
  assert.match(reason(reviewSignPayload({ ...good, amount: "1.0000001" }, "sandbox", 20_000_000n)), /decimal places/);
  assert.match(reason(reviewSignPayload({ ...good, amount: "0" }, "sandbox", 20_000_000n)), /above zero/);
  assert.match(reason(reviewSignPayload(good, "sandbox", 1n)), /enough USDC/);
  assert.match(reason(reviewSignPayload({ ...good, asset: "SOL" }, "sandbox", 20_000_000n)), /not USDC/);
});

test("amounts convert without floats, and funds_received is not terminal", () => {
  assert.equal(toBaseUnits("6.66", 6), 6_660_000n);
  assert.throws(() => toBaseUnits("1e3", 6));
  assert.equal(CASH_OUT_TERMINAL.has("funds_received"), false);
  assert.equal(CASH_OUT_TERMINAL.has("paid_out"), true);
});


test("malformed provider amounts are rejected rather than truncated", () => {
  for (const amount of ["1.2.3", "1..", "1.", ".1", "1e3", " 1", "-1"]) {
    assert.throws(() => toBaseUnits(amount, 6), /decimal string/);
    assert.equal(reviewSignPayload({ ...good, amount }, "sandbox", 20_000_000n).ok, false);
  }
});
