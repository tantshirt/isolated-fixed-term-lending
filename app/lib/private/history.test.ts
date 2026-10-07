import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import {
  CREDIT_HISTORY_LEN,
  decodeCreditHistory,
  decodeHistoryAttestation,
  HISTORY_ATTESTATION_DISCRIMINATOR,
  HISTORY_ATTESTATION_LEN,
  historyCsv,
  historyJson,
  repaidOf,
} from "./history";

const borrower = Keypair.generate().publicKey;
const loans = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];

function historyBytes(count = loans.length) {
  const b = Buffer.alloc(CREDIT_HISTORY_LEN);
  b[0] = 1;
  borrower.toBuffer().copy(b, 1);
  [2, 1, 0, 0, 0].forEach((n, i) => b.writeUInt32LE(n, 33 + 4 * i));
  b.writeBigInt64LE(1_800_000_000n, 53);
  b.writeUInt16LE(count, 61);
  loans.forEach((l, i) => l.toBuffer().copy(b, 63 + 32 * i));
  b[CREDIT_HISTORY_LEN - 1] = 254;
  return b;
}

test("the CreditHistory layout matches history.rs (1088 bytes, no discriminator)", () => {
  assert.equal(CREDIT_HISTORY_LEN, 1088);
  const h = decodeCreditHistory(historyBytes())!;
  assert.equal(h.version, 1);
  assert.equal(h.borrower, borrower.toBase58());
  assert.deepEqual([h.onTime, h.late, h.liquidated, h.defaulted, h.refinanced], [2, 1, 0, 0, 0]);
  assert.equal(repaidOf(h), 3);
  assert.equal(h.lastSettledAt, 1_800_000_000);
  assert.deepEqual(h.loans, loans.map((l) => l.toBase58()));
  assert.equal(h.bump, 254);
  assert.equal(decodeCreditHistory(historyBytes().subarray(0, 1000)), null);
  assert.equal(decodeCreditHistory(historyBytes(33)), null);
});

test("the HistoryAttestation layout matches its Anchor discriminator and fields", () => {
  assert.deepEqual([...HISTORY_ATTESTATION_DISCRIMINATOR], [...createHash("sha256").update("account:HistoryAttestation").digest().subarray(0, 8)]);
  assert.equal(HISTORY_ATTESTATION_LEN, 80);
  const b = Buffer.alloc(HISTORY_ATTESTATION_LEN);
  Buffer.from(HISTORY_ATTESTATION_DISCRIMINATOR).copy(b, 0);
  b[8] = 1;
  borrower.toBuffer().copy(b, 9);
  [3, 2, 1, 1, 0].forEach((n, i) => b.writeUInt32LE(n, 41 + 4 * i));
  b.writeUInt16LE(5, 61);
  b.writeBigUInt64LE(123_456_789n, 63);
  b.writeBigInt64LE(1_800_000_100n, 71);
  b[79] = 253;
  const a = decodeHistoryAttestation(b)!;
  assert.deepEqual(
    [a.version, a.borrower, a.repaid, a.onTime, a.late, a.liquidated, a.defaulted, a.loansCounted, a.rollupSlot, a.attestedAt, a.bump],
    [1, borrower.toBase58(), 3, 2, 1, 1, 0, 5, 123_456_789n, 1_800_000_100, 253],
  );
  b[0] ^= 1;
  assert.equal(decodeHistoryAttestation(b), null);
  assert.equal(decodeHistoryAttestation(b.subarray(0, 79)), null);
});

test("exports carry counts, the counted loans and the activity-record note only", () => {
  const h = decodeCreditHistory(historyBytes())!;
  const json = JSON.parse(historyJson(h, 1_800_000_500));
  assert.deepEqual(json.counts, { repaid: 3, onTime: 2, late: 1, liquidated: 0, defaulted: 0, refinanced: 0 });
  assert.deepEqual(json.loans, loans.map((l) => l.toBase58()));
  assert.match(json.note, /Activity record/);
  const csv = historyCsv(h, 1_800_000_500).split("\n");
  assert.match(csv[0], /^# Activity record/);
  assert.equal(csv[2].split(",")[2], "3");
  assert.deepEqual(csv.slice(5, 8), loans.map((l) => l.toBase58()));
});

test("history reads and exports stay in the browser: no server, Convex or telemetry", () => {
  for (const f of [join(__dirname, "history.ts"), join(__dirname, "..", "..", "components", "credit", "HistoryPanel.tsx")]) {
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /convex|fetch\(|\/api\/|console\.|posthog|sentry|localStorage/i, f);
  }
});
