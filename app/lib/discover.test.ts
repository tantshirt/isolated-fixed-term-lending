import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILTERS, applyFilters, readView, type Facts } from "./discover";

type Row = { id: string } & Facts;
const rows: Row[] = [
  { id: "a", amount: 100n, rateBps: 500, durationSeconds: 86_400, ts: 3 },
  { id: "b", amount: 900n, rateBps: 1500, durationSeconds: 30 * 86_400, ts: 1 },
  { id: "c", amount: null, rateBps: null, durationSeconds: null, ts: 2 },
  { id: "d", amount: 500n, rateBps: 200, durationSeconds: 7 * 86_400, ts: 4 },
];
const ids = (r: Row[]) => r.map((x) => x.id);

test("newest first by default, nothing hidden", () => {
  assert.deepEqual(ids(applyFilters(rows, (r) => r, DEFAULT_FILTERS)), ["d", "a", "c", "b"]);
});

test("rate and term caps keep rows whose field was not shared", () => {
  const f = { ...DEFAULT_FILTERS, maxRateBps: 1000, term: "7d" as const };
  assert.deepEqual(ids(applyFilters(rows, (r) => r, f)), ["d", "a", "c"]);
});

test("largest and lowest-rate sorts put unknowns last", () => {
  assert.deepEqual(ids(applyFilters(rows, (r) => r, { ...DEFAULT_FILTERS, sort: "largest" })), ["b", "d", "a", "c"]);
  assert.deepEqual(ids(applyFilters(rows, (r) => r, { ...DEFAULT_FILTERS, sort: "rate" })), ["d", "a", "b", "c"]);
});

test("view falls back to public borrower requests", () => {
  const q = (s: string) => new URLSearchParams(s);
  assert.deepEqual(readView(q("")), { side: "borrowers", venue: "public" });
  assert.deepEqual(readView(q("side=lenders&venue=private")), { side: "lenders", venue: "private" });
  assert.deepEqual(readView(q("side=x&venue=y")), { side: "borrowers", venue: "public" });
});
