import test from "node:test";
import assert from "node:assert/strict";
import { createSharedRead } from "./shared-read";
import { createRpcFetch } from "./rpc-fetch";

test("concurrent consumers share one read and explicit refresh bypasses its snapshot", async () => {
  let time = 0,
    calls = 0;
  const read = createSharedRead(() => time);
  const load = async () => ++calls;
  assert.deepEqual(
    await Promise.all([
      read("price:0", load),
      read("price:0", load),
      read("price:0", load),
    ]),
    [1, 1, 1]
  );
  assert.equal(await read("price:1", load), 2);
  time = 1001;
  assert.equal(await read("price:0", load), 3);
});

test("rate limits stop endpoint requests until Retry-After, without replaying writes", async () => {
  let time = 0,
    calls = 0;
  const fake: typeof fetch = async () => {
    calls++;
    return calls === 1
      ? new Response("busy", { status: 429, headers: { "Retry-After": "60" } })
      : new Response("ok");
  };
  const request = createRpcFetch(fake, () => time);
  await assert.rejects(request("https://rpc.test"), /rate limited/);
  time = 30_001;
  await assert.rejects(
    request("https://rpc.test", { method: "POST", body: "sendTransaction" }),
    /rate limited/
  );
  assert.equal(calls, 1);
  time = 60_001;
  assert.equal(await (await request("https://rpc.test")).text(), "ok");
  assert.equal(calls, 2);
});

test("failed shared reads stay unavailable during backoff then recover without stale values", async () => {
  let time = 0,
    calls = 0;
  const read = createSharedRead(() => time);
  const load = async () => {
    if (++calls === 1) throw new Error("429");
    return 7;
  };
  await assert.rejects(read("price", load), /429/);
  time = 5_000;
  await assert.rejects(read("price", load), /429/);
  assert.equal(calls, 1);
  time = 30_001;
  assert.equal(await read("price", load), 7);
});

test("price endpoint translates upstream rate limiting into retryable unavailability", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("rate limited", { status: 429 });
  try {
    const { GET } = await import("../app/api/price/route");
    const response = await GET(new Request("http://localhost/api/price"));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "30");
    assert.match((await response.json()).error, /Devnet is busy/);
  } finally { globalThis.fetch = original; }
});
