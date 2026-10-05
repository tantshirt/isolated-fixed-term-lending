/** Coalesce UI reads only. Never wrap transaction submission or pre-sign checks. */
export function createSharedRead(now = Date.now) {
  const entries = new Map<
    string,
    { until: number; promise: Promise<unknown> }
  >();
  return function read<T>(
    key: string,
    load: () => Promise<T>,
    ttl = 1_000
  ): Promise<T> {
    const existing = entries.get(key);
    if (existing && existing.until > now())
      return existing.promise as Promise<T>;
    const entry = {
      until: Infinity,
      promise: Promise.resolve().then(load) as Promise<unknown>,
    };
    entries.set(key, entry);
    entry.promise = entry.promise.then(
      (value) => {
        entry.until = now() + ttl;
        return value;
      },
      (error) => {
        entry.until =
          now() +
          (/429|rate.limit|too many requests/i.test(String(error))
            ? 30_000
            : 3_000);
        throw error;
      }
    );
    // Keep the cache bounded as users browse different loan accounts.
    if (entries.size > 200)
      for (const [k, item] of entries) {
        if (item.until <= now()) entries.delete(k);
      }
    return entry.promise as Promise<T>;
  };
}
export const sharedRead = createSharedRead();
