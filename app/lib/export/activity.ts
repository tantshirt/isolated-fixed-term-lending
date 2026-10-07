/**
 * Activity export (Story 26.8, research.md § Activity export). One row per on-chain action. Public
 * rows are rebuilt from chain behind a `(slot, signature)` cursor, so replaying the same chain data
 * always yields the same file. Private rows are assembled only in the browser. This module is pure:
 * no network, no imports, so the CSV is a function of its rows alone.
 */

export type Role = "borrower" | "lender" | "buyer" | "seller" | "liquidator" | "keeper" | "other";

export type ActivityRow = {
  /** ISO 8601 in UTC, ending in Z. */
  timeUtc: string;
  slot: number;
  signature: string;
  /** The loan account (public offer or private loan anchor). */
  loan: string;
  role: Role;
  action: string;
  /** USDC, wSOL, jitoSOL or another asset label. */
  asset: string;
  /** Integer atoms as a decimal string. */
  amountAtoms: string;
  /** The same amount in whole units, exact (no floating point). */
  amountDecimal: string;
  /** Network fee in lamports for public rows; "0" for private rows. */
  fee: string;
  /** The loan's status after this action. */
  status: string;
};

export type Cursor = { slot: number; signature: string };

export const CSV_HEADER = "time_utc,slot,signature,loan,role,action,asset,amount_atoms,amount,fee,status";
export const CSV_FOOTER = "Activity record, not tax advice.";
const EOL = "\r\n";

/** Exact decimal string for `atoms` at `decimals`, e.g. (1500000n, 6) → "1.500000". */
export function atomsToDecimal(atoms: bigint, decimals: number): string {
  const neg = atoms < 0n;
  const a = neg ? -atoms : atoms;
  if (decimals === 0) return `${neg ? "-" : ""}${a}`;
  const base = 10n ** BigInt(decimals);
  return `${neg ? "-" : ""}${a / base}.${(a % base).toString().padStart(decimals, "0")}`;
}

export const isoUtc = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Order by slot, then signature (byte order of the base58 string). */
export function compareCursor(a: Cursor, b: Cursor): number {
  return a.slot !== b.slot ? a.slot - b.slot : cmpStr(a.signature, b.signature);
}

const rowKey = (r: ActivityRow) => `${r.slot}|${r.signature}|${r.loan}|${r.action}|${r.role}|${r.asset}|${r.amountAtoms}`;

/** Sorted by (slot, signature, loan, action) with exact duplicates removed. Same set in, same list out. */
export function normalize(rows: ActivityRow[]): ActivityRow[] {
  const unique = new Map<string, ActivityRow>();
  for (const r of rows) unique.set(rowKey(r), r);
  return [...unique.values()].sort((a, b) => compareCursor(a, b) || cmpStr(a.loan, b.loan) || cmpStr(a.action, b.action) || cmpStr(rowKey(a), rowKey(b)));
}

/** Rows strictly after `cursor`; with no cursor, every row. */
export function rowsAfter(rows: ActivityRow[], cursor: Cursor | null): ActivityRow[] {
  const all = normalize(rows);
  return cursor ? all.filter((r) => compareCursor(r, cursor) > 0) : all;
}

/** The cursor to resume from after exporting `rows`, or null when there are none. */
export function nextCursor(rows: ActivityRow[]): Cursor | null {
  const all = normalize(rows);
  const last = all.at(-1);
  return last ? { slot: last.slot, signature: last.signature } : null;
}

/** RFC 4180: quote a field holding a comma, quote, CR or LF, doubling inner quotes. */
export function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(rows: ActivityRow[]): string {
  const lines = normalize(rows).map((r) =>
    [r.timeUtc, String(r.slot), r.signature, r.loan, r.role, r.action, r.asset, r.amountAtoms, r.amountDecimal, r.fee, r.status].map(csvField).join(","),
  );
  return [CSV_HEADER, ...lines, CSV_FOOTER].join(EOL) + EOL;
}
