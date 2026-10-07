import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURE_EVIDENCE, featureStatus, type FeatureId } from "./feature-status";

const ROOT = join(__dirname, "..", "..");

function resolve(pointer: string): unknown {
  const [file, path] = pointer.split("#");
  let value: unknown = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  for (const key of path.split(".")) value = (value as Record<string, unknown>)?.[key];
  return value;
}

test("every live feature points at Devnet evidence that exists", () => {
  for (const [id, entry] of Object.entries(FEATURE_EVIDENCE)) {
    if (featureStatus(id as FeatureId) !== "live" || id === "alerts") continue;
    assert.ok(entry.evidence, `${id} is live without evidence`);
    const value = resolve(entry.evidence!);
    assert.ok(value !== undefined && value !== false && value !== null, `${id}: ${entry.evidence} is missing`);
  }
});

test("Telegram and MoneyGram badges follow their deployment flags", () => {
  // The flags are read at import time, so this checks the defaults of an unconfigured build.
  if (process.env.NEXT_PUBLIC_TELEGRAM_ENABLED !== "1") assert.equal(featureStatus("alerts"), "pilot");
  if (process.env.NEXT_PUBLIC_MONEYGRAM_ENABLED !== "1") assert.equal(featureStatus("cash-out"), "pilot");
});

test("MoneyGram is never shown as live, only sandbox or pilot", () => {
  assert.notEqual(featureStatus("cash-out"), "live");
});
