import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { pollAfterCompletion } from "./poll";

test("slow room/quote reads finish before another poll starts and cleanup stops rescheduling", async () => {
  let resolve!: () => void;
  let calls = 0;
  let applied = 0;
  const stop = pollAfterCompletion(async () => {
    calls++;
    if (calls === 1) await new Promise<void>((r) => { resolve = r; });
    applied++;
  }, 2);
  await sleep(25); // More than ten polling periods, while the controlled RPC is unresolved.
  assert.equal(calls, 1);
  resolve();
  await sleep(12);
  assert.ok(applied >= 2, "The slow result applied and polling resumed afterwards");
  stop();
  const count = calls;
  await sleep(12);
  assert.equal(calls, count);
});

test("stopping during an unresolved read cannot restart polling", async () => {
  let resolve!: () => void;
  let calls = 0;
  const stop = pollAfterCompletion(() => { calls++; return new Promise<void>((r) => { resolve = r; }); }, 1);
  stop(); resolve();
  await sleep(10);
  assert.equal(calls, 1);
});
