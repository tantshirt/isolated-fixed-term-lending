import test from "node:test";
import assert from "node:assert/strict";
import { HEARTBEAT_TIMEOUT_MS, liveStatus, upsert } from "./live-state";

type Row = { k: string; n: number };
const keyOf = (r: Row) => r.k;

test("upsert inserts, replaces and removes by key", () => {
  let list = upsert<Row>(null, "a", { k: "a", n: 1 }, keyOf);
  list = upsert(list, "b", { k: "b", n: 2 }, keyOf);
  list = upsert(list, "a", { k: "a", n: 3 }, keyOf);
  assert.deepEqual(list.map((r) => [r.k, r.n]).sort(), [["a", 3], ["b", 2]]);
  list = upsert(list, "b", null, keyOf);
  assert.deepEqual(list, [{ k: "a", n: 3 }]);
});

test("upsert keeps the requested order", () => {
  const byN = (a: Row, b: Row) => b.n - a.n;
  let list = upsert<Row>([{ k: "a", n: 5 }], "b", { k: "b", n: 1 }, keyOf, byN);
  list = upsert(list, "c", { k: "c", n: 9 }, keyOf, byN);
  assert.deepEqual(list.map((r) => r.k), ["c", "a", "b"]);
});

test("status is live only while the heartbeat is recent", () => {
  const now = 1_000_000;
  assert.equal(liveStatus({ now, lastBeat: now - 1_000, subscribed: true, lastLoadOk: true }), "live");
  assert.equal(
    liveStatus({ now, lastBeat: now - HEARTBEAT_TIMEOUT_MS, subscribed: true, lastLoadOk: true }),
    "polling"
  );
  assert.equal(liveStatus({ now, lastBeat: now, subscribed: false, lastLoadOk: true }), "polling");
  assert.equal(liveStatus({ now, lastBeat: null, subscribed: true, lastLoadOk: null }), "connecting");
  assert.equal(liveStatus({ now, lastBeat: null, subscribed: true, lastLoadOk: false }), "offline");
});
