import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SCHEMA_SECRET_PATTERN, SECRET_FIELD_PATTERN } from "./shield";

/**
 * Story 26.6: viewing keys and Umbra secrets stay in memory, derived from the wallet. None may be
 * named in what Convex stores, in notification, telemetry or export code, or in browser storage.
 */
const APP = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "_generated" || name.startsWith(".")) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const read = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const source = ["convex", "lib", "components", "app"].flatMap((d) => walk(join(APP, d)));
const rel = (p: string) => relative(APP, p);

test("the patterns catch the fields they are meant to", () => {
  for (const bad of ["viewingKey: v.string()", "masterSeed", "master_viewing_key", "spendingKey", "x25519PrivateKey", "seedPhrase", "umbraSignature"])
    assert.match(bad, SECRET_FIELD_PATTERN, bad);
  assert.match("privateKey: v.bytes()", SCHEMA_SECRET_PATTERN);
  assert.doesNotMatch("wallet: v.string(), signature: v.string()", SCHEMA_SECRET_PATTERN);
});

test("the Convex schema stores no viewing key, seed or private key", () => {
  const schema = read(join(APP, "convex", "schema.ts"));
  assert.doesNotMatch(schema, SCHEMA_SECRET_PATTERN);
});

test("no Convex function, notification, telemetry or export module names an Umbra secret", () => {
  const scoped = source.filter((p) => rel(p).startsWith("convex/") || rel(p).startsWith("lib/alerts/") || /telemetry|analytics|export|notif/i.test(rel(p)));
  assert.ok(scoped.some((p) => rel(p) === "convex/schema.ts"), "the scan must include the Convex schema");
  for (const p of scoped) {
    const text = read(p);
    assert.doesNotMatch(text, SECRET_FIELD_PATTERN, rel(p));
    // An ops pause flag may name the provider; importing Umbra code or the SDK is what is forbidden.
    assert.doesNotMatch(text, /from\s+["'](@umbra-privacy\/|[^"']*lib\/umbra\/)|import\(["'][^"']*umbra/i, `${rel(p)} must not import Umbra code`);
  }
});

test("the Umbra code keeps keys in memory: no browser storage, no backend calls", () => {
  const umbra = source.filter((p) => rel(p).startsWith("lib/umbra/") || rel(p).startsWith("components/shield/"));
  assert.ok(umbra.length >= 3);
  for (const p of umbra) {
    const text = read(p);
    assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|document\.cookie/, rel(p));
    assert.doesNotMatch(text, /convex|authorizedPost|fetch\(/i, rel(p));
  }
});

test("the Umbra SDK is imported only by the lazily loaded session module", () => {
  for (const p of source) {
    const text = read(p);
    if (rel(p) === "lib/umbra/session.ts") continue;
    assert.doesNotMatch(text, /from\s+["']@umbra-privacy\/sdk/, `${rel(p)} imports the Umbra SDK eagerly`);
    if (/import\s+(?!type\b)[^;]*from\s+["']@\/lib\/umbra\/session["']/.test(text)) assert.fail(`${rel(p)} imports the session module eagerly`);
  }
  assert.match(read(join(APP, "components", "shield", "ShieldPanel.tsx")), /await import\("@\/lib\/umbra\/session"\)/);
});
