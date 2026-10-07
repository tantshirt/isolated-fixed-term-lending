import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import registry from "../public/brands/registry.json";

const DIR = join(__dirname, "..", "public", "brands");

test("every logo file is registered with a matching hash", () => {
  const files = readdirSync(DIR).filter((f) => /\.(svg|png|webp)$/.test(f));
  for (const f of files) {
    const entry = registry.assets.find((a) => a.file === f);
    assert.ok(entry, `${f} has no registry entry`);
    const hash = createHash("sha256").update(readFileSync(join(DIR, f))).digest("hex");
    assert.equal(hash, entry.sha256, `${f} changed without updating the registry`);
  }
});

test("every registry entry has provenance and a placement", () => {
  for (const a of registry.assets) {
    assert.match(a.retrieved, /^\d{4}-\d{2}-\d{2}$/, a.id);
    assert.ok(a.source && a.sourcePage && a.placement, a.id);
  }
});

test("providers without sourced artwork are text labels, not logos", () => {
  const withLogo = new Set(registry.assets.map((a) => a.provider));
  for (const t of registry.textLabels) assert.equal(withLogo.has(t.provider), false, t.provider);
});

test("every provider logo the pages use is registered", async () => {
  const { PROVIDER_LOGO_FILES } = await import("./provider-logos");
  for (const f of PROVIDER_LOGO_FILES) assert.ok(registry.assets.some((a) => a.file === f), `${f} is not in the registry`);
});

test("logo styles never recolor official artwork", () => {
  const css = readFileSync(join(__dirname, "..", "components", "brand", "ProviderLogo.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /\b(filter|fill|mix-blend-mode|opacity)\s*:/);
});
