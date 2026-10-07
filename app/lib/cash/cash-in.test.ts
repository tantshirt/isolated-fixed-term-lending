import test from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { RAMPS, cashWidgetConfig, createdTransactionError, cashInShortfall, depositAssetOk, isTerminal, nextCashStatus, strkeyToEd25519, type CashDirection } from "./moneygram";
import { handleWebhook, type WebhookDeps } from "./webhook";
import { cashInEnabled, CAPABILITIES, capabilityFor, DEVNET_USDC, type Capability } from "../capabilities";

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
const MINT = RAMPS.sandbox.usdcMint;

const deposit = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ transaction: { id: "mgi-1", network: "SOL", kind: "deposit", status: "completed", amount_out: "25", amount_out_asset: `solana:USDC:${MINT}`, ...over } });
const signed = (msg: string, t = NOW / 1000, k = kp.secretKey) =>
  `t=${t},s=${Buffer.from(nacl.sign.detached(new TextEncoder().encode(`${t}.${host}.${msg}`), k)).toString("base64")}`;

/** In-memory stand-ins for the Convex calls the webhook route makes. */
function harness(rows: Record<string, { rampsId: string; direction?: CashDirection }> = { "mgi-1": { rampsId: "r-1", direction: "in" } }) {
  const seen = new Set<string>();
  const reconciled: string[] = [];
  const failures: string[] = [];
  const deps: WebhookDeps = {
    claimEvent: async (k) => (seen.has(k) ? false : (seen.add(k), true)),
    findRow: async (id) => rows[id] ?? null,
    reconcile: async (id) => reconciled.push(id),
    recordFailure: async (r) => failures.push(r),
  };
  const deliver = (msg: string, signature: string | null = signed(msg), now = NOW) =>
    handleWebhook({ signature, rawBody: JSON.stringify({ message: msg }), host, webhookKey: key, env: "sandbox", now }, deps);
  return { deliver, reconciled, failures };
}

test("test key round-trips through the strkey decoder", () => {
  assert.deepEqual(strkeyToEd25519(key), kp.publicKey);
});

test("a genuine deposit webhook reconciles the cash-in it belongs to", async () => {
  const h = harness();
  assert.deepEqual(await h.deliver(deposit()), { status: 200, handled: "reconcile" });
  assert.deepEqual(h.reconciled, ["r-1"]);
});

test("forged deposit webhooks are refused and never reconciled", async () => {
  const h = harness();
  const msg = deposit();
  const forger = nacl.sign.keyPair();
  assert.deepEqual(await h.deliver(msg, signed(msg, NOW / 1000, forger.secretKey)), { status: 401, handled: "rejected" });
  // Signed body, then a tampered status: the signature no longer covers it.
  assert.deepEqual(await h.deliver(deposit({ status: "refunded" }), signed(msg)), { status: 401, handled: "rejected" });
  assert.deepEqual(await h.deliver(msg, null), { status: 401, handled: "rejected" });
  assert.deepEqual(h.reconciled, []);
  assert.deepEqual(h.failures, ["moneygram-bad-signature", "moneygram-bad-signature", "moneygram-no-signature"]);
});

test("replayed deposit webhooks are acted on once, and stale replays never", async () => {
  const h = harness();
  const msg = deposit();
  await h.deliver(msg);
  assert.deepEqual(await h.deliver(msg), { status: 200, handled: "duplicate" });
  assert.deepEqual(await h.deliver(msg, signed(msg, NOW / 1000 + 30)), { status: 200, handled: "duplicate" });
  assert.deepEqual(await h.deliver(msg, signed(msg, NOW / 1000 - 66 * 60)), { status: 200, handled: "stale" });
  assert.deepEqual(h.reconciled, ["r-1"]);
});

test("deposits naming another mint, asset or chain are refused", async () => {
  const h = harness();
  for (const over of [
    { amount_out_asset: `solana:USDC:${RAMPS.production.usdcMint}` },
    { amount_out_asset: RAMPS.production.usdcMint },
    { amount_out_asset: "solana:USDT:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
    { amount_out_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    { network: "stellar" },
  ]) {
    assert.deepEqual(await h.deliver(deposit({ ...over, id: `x-${JSON.stringify(over)}` })), { status: 200, handled: "rejected" });
  }
  assert.deepEqual(h.reconciled, []);
  assert.deepEqual(h.failures, ["moneygram-deposit-wrong-mint", "moneygram-deposit-wrong-mint", "moneygram-deposit-wrong-asset", "moneygram-deposit-wrong-asset", "moneygram-deposit-wrong-network"]);
  for (const asset of ["USDC", MINT, `solana:USDC:${MINT}`, undefined]) assert.equal(depositAssetOk({ id: "a", kind: "deposit", network: "SOL", status: "completed", amount_out_asset: asset }, "sandbox").ok, true);
});

test("a deposit webhook cannot drive a cash-out row, or the reverse", async () => {
  const h = harness({ "mgi-1": { rampsId: "out-1" }, "mgi-2": { rampsId: "in-2", direction: "in" } });
  assert.deepEqual(await h.deliver(deposit()), { status: 200, handled: "rejected" });
  assert.deepEqual(await h.deliver(JSON.stringify({ transaction: { id: "mgi-2", network: "SOL", kind: "withdrawal", status: "completed" } })), { status: 200, handled: "rejected" });
  assert.deepEqual(h.reconciled, []);
  assert.deepEqual(h.failures, ["moneygram-wrong-kind", "moneygram-wrong-kind"]);
});

test("cash-in follows API lifecycle and refuses obsolete or cash-out states", () => {
  for (const [before, after] of [["created", "validated"], ["validated", "pending_kyc"], ["pending_kyc", "committed"], ["committed", "funds_received"], ["funds_received", "completed"]]) {
    assert.equal(nextCashStatus("in", before, after), after);
  }
  assert.equal(nextCashStatus("in", "funds_received", "committed"), null);
  assert.equal(nextCashStatus("in", "created", "quote_expired"), "quote_expired");
  for (const terminal of ["failed", "quote_expired", "completed"]) {
    assert.equal(isTerminal("in", terminal), true);
    assert.equal(nextCashStatus("in", terminal, "committed"), null);
    assert.equal(nextCashStatus("in", terminal, "refund_requested"), null);
  }
  for (const unknown of ["awaiting_funds", "pending_transfer", "expired", "refunded", "pending_anchor"]) assert.equal(nextCashStatus("in", "committed", unknown), null);
  assert.equal(isTerminal("in", "funds_received"), false);
  assert.equal(nextCashStatus("out", "paid_out", "refunded"), "refunded");
  assert.equal(isTerminal("out", "completed"), false);
});

test("widget builder sets all documented selectors and replaces duplicate URL modes", () => {
  for (const [direction, mode] of [["in", "on-ramp"], ["out", "off-ramp"]] as const) {
    const config = cashWidgetConfig(direction, "https://widget.example/?session=abc&mode=off-ramp&mode=on-ramp");
    const url = new URL(config.widgetUrl);
    assert.deepEqual(url.searchParams.getAll("mode"), [mode]);
    assert.equal(url.searchParams.get("session"), "abc");
    assert.equal(config.mode, mode);
    assert.deepEqual(config.transaction, { type: mode });
    assert.equal("flow" in config, false);
  }
  assert.throws(() => cashWidgetConfig("unknown" as CashDirection, "https://widget.example/"));
});

test("creation events must identify direction, wallet and asset", () => {
  const tx = { id: "r1", type: "cash-in", chain: "solana", asset: "USDC", walletAddress: "wallet1" };
  assert.equal(createdTransactionError(tx, "in", "wallet1"), null);
  assert.equal(createdTransactionError({ ...tx, type: "cash-out" }, "out", "wallet1"), null);
  for (const patch of [{ type: undefined }, { type: "cash-out" }, { chain: "stellar" }, { asset: "USDT" }, { walletAddress: "other" }]) assert.ok(createdTransactionError({ ...tx, ...patch }, "in", "wallet1"));
});

test("signed webhooks cannot guess direction or Solana network", async () => {
  for (const kind of [undefined, "unknown"]) {
    const h = harness();
    const result = await h.deliver(deposit({ kind }));
    assert.equal(result.handled, "rejected");
    assert.deepEqual(h.reconciled, []);
  }
  const h = harness();
  assert.deepEqual(await h.deliver(deposit({ network: undefined })), { status: 200, handled: "rejected" });
  assert.deepEqual(h.reconciled, []);
});

test("capability cash-in follows its own flag and still needs MoneyGram", () => {
  assert.equal(cashInEnabled("1", "1"), true);
  assert.equal(cashInEnabled("1", undefined), false);
  assert.equal(cashInEnabled(undefined, "1"), false);
  assert.equal(cashInEnabled("1", "true"), false);
  const expected = process.env.NEXT_PUBLIC_MONEYGRAM_ENABLED === "1" && process.env.NEXT_PUBLIC_MONEYGRAM_CASH_IN_ENABLED === "1";
  assert.equal(capabilityFor("moneygram", "devnet", DEVNET_USDC, "cash-in").available, expected);
  const on: Capability[] = CAPABILITIES.map((c) => (c.operation === "cash-in" ? { ...c, available: cashInEnabled("1", "1") } : c));
  assert.deepEqual(capabilityFor("moneygram", "devnet", DEVNET_USDC, "cash-in", on), { available: true });
  assert.equal(capabilityFor("moneygram", "mainnet", DEVNET_USDC, "cash-in", on).available, false);
  const off = capabilityFor("moneygram", "devnet", DEVNET_USDC, "cash-in", CAPABILITIES.map((c) => ({ ...c, available: false })));
  assert.equal(!off.available && off.reason, "MoneyGram cash-in is not connected on this deployment yet.");
});

test("the shortfall says how much USDC a repayment still needs", () => {
  assert.equal(cashInShortfall(25_000_000n, 10_000_000n), 15_000_000n);
  assert.equal(cashInShortfall(25_000_000n, 30_000_000n), 0n);
  assert.equal(cashInShortfall(25_000_000n, null), 25_000_000n);
});
