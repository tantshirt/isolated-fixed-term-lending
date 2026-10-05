import test from "node:test";
import assert from "node:assert/strict";
import { readChainClock } from "./client/chain-clock";
test("clock reads confirmed chain time independently of oracle or local wall time", async () => {
  const calls: unknown[] = [];
  const time = await readChainClock({
    getSlot: async (commitment) => {
      calls.push(commitment);
      return 42;
    },
    getBlockTime: async (slot) => {
      calls.push(slot);
      return 1234;
    },
  });
  assert.equal(time, 1234);
  assert.deepEqual(calls, ["confirmed", 42]);
});
test("unavailable or malformed chain clocks remain unknown rather than using local time", async () => {
  for (const time of [null, NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      readChainClock({
        getSlot: async () => 42,
        getBlockTime: async () => time,
      }),
      /unavailable/
    );
  }
  await assert.rejects(
    readChainClock({
      getSlot: async () => {
        throw new Error("RPC unavailable");
      },
      getBlockTime: async () => 1234,
    }),
    /RPC unavailable/
  );
});
