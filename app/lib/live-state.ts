/** Pure pieces of the live account lists, kept apart from React so they can be tested. */

export type LiveStatus = "connecting" | "live" | "polling" | "offline";

/** No slot notification for this long means the socket is dead. */
export const HEARTBEAT_TIMEOUT_MS = 15_000;
export const POLL_MS = 15_000;
export const RECONCILE_MS = 60_000;

/** Replaces or inserts `item` by key, or removes the key when `item` is null. */
export function upsert<T>(
  list: T[] | null,
  key: string,
  item: T | null,
  keyOf: (t: T) => string,
  sort?: (a: T, b: T) => number
): T[] {
  const rest = (list ?? []).filter((t) => keyOf(t) !== key);
  const next = item ? [item, ...rest] : rest;
  return sort ? next.sort(sort) : next;
}

/** What the badge should say, given the last heartbeat and the last successful read. */
export function liveStatus(s: {
  now: number;
  lastBeat: number | null;
  subscribed: boolean;
  lastLoadOk: boolean | null;
}): LiveStatus {
  const socketUp =
    s.subscribed && s.lastBeat !== null && s.now - s.lastBeat < HEARTBEAT_TIMEOUT_MS;
  if (socketUp) return "live";
  if (s.lastLoadOk === false) return "offline";
  if (s.lastLoadOk === null) return "connecting";
  return "polling";
}
