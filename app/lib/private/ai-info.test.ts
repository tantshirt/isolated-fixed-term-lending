import { test } from "node:test";
import assert from "node:assert/strict";
import { aiInfo } from "./ai";

test("AI availability rejects JSON HTTP failures and can recover on retry", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 });
    await assert.rejects(aiInfo(), /availability could not be checked/);
    globalThis.fetch = async () => new Response(JSON.stringify({ configured: false, model: "", provider: "" }));
    assert.equal((await aiInfo()).configured, false);
    globalThis.fetch = async () => new Response(JSON.stringify({ configured: true, model: "test", provider: "test" }));
    assert.equal((await aiInfo()).configured, true);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "bad payload" }));
    await assert.rejects(aiInfo(), /invalid/);
  } finally { globalThis.fetch = original; }
});
