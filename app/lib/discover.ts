/** Filtering and sorting shared by every Discover list. Unknown fields never hide a row; they sort last. */

export type TermBucket = "any" | "1d" | "7d" | "30d" | "90d";
export type SortKey = "newest" | "largest" | "rate";
export type Side = "borrowers" | "lenders";
export type Venue = "public" | "private";

export const TERM_MAX: Record<TermBucket, number> = {
  any: Infinity,
  "1d": 86_400,
  "7d": 7 * 86_400,
  "30d": 30 * 86_400,
  "90d": 90 * 86_400,
};

export const MAX_RATE_BPS = 2000;

export type Facts = {
  amount: bigint | null;
  rateBps: number | null;
  durationSeconds: number | null;
  /** Newer is larger. */
  ts: number;
};

export type Filters = { maxRateBps: number; term: TermBucket; sort: SortKey };

export const DEFAULT_FILTERS: Filters = { maxRateBps: MAX_RATE_BPS, term: "any", sort: "newest" };

export function applyFilters<T>(items: T[], facts: (t: T) => Facts, f: Filters): T[] {
  const kept = items
    .map((item) => ({ item, x: facts(item) }))
    .filter(
      ({ x }) =>
        (x.rateBps === null || x.rateBps <= f.maxRateBps) &&
        (x.durationSeconds === null || x.durationSeconds <= TERM_MAX[f.term])
    );
  const unknownLast = (a: unknown, b: unknown) => (a === null ? 1 : 0) - (b === null ? 1 : 0);
  kept.sort((a, b) => {
    if (f.sort === "largest") {
      const u = unknownLast(a.x.amount, b.x.amount);
      if (u || a.x.amount === null || b.x.amount === null) return u;
      return a.x.amount === b.x.amount ? b.x.ts - a.x.ts : a.x.amount < b.x.amount ? 1 : -1;
    }
    if (f.sort === "rate") {
      const u = unknownLast(a.x.rateBps, b.x.rateBps);
      if (u || a.x.rateBps === null || b.x.rateBps === null) return u;
      return a.x.rateBps - b.x.rateBps || b.x.ts - a.x.ts;
    }
    return b.x.ts - a.x.ts;
  });
  return kept.map(({ item }) => item);
}

/** Reads `side` and `venue` from a query string, falling back to the borrowers' public list. */
export function readView(params: { get(name: string): string | null }): { side: Side; venue: Venue } {
  const side = params.get("side") === "lenders" ? "lenders" : "borrowers";
  const venue = params.get("venue") === "private" ? "private" : "public";
  return { side, venue };
}
