import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("bundled gate evidence matches docs/magicblock-evidence.json", () => {
  const bundled = readFileSync(new URL("./private/evidence.json", import.meta.url), "utf8");
  const source = readFileSync(new URL("../../docs/magicblock-evidence.json", import.meta.url), "utf8");
  assert.deepEqual(JSON.parse(bundled), JSON.parse(source), "run `npm run sync-evidence`");
});
