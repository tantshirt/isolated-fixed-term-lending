/** A rate-limited endpoint gets one shared cooldown, rather than retries per component. */
export function createRpcFetch(
  fetcher: typeof fetch = fetch,
  now = Date.now
): typeof fetch {
  const cooldowns = new Map<string, number>();
  return async (input, init) => {
    const endpoint = String(input);
    if ((cooldowns.get(endpoint) ?? 0) > now())
      throw new Error(
        "Devnet RPC is rate limited (429). Retrying after a short pause."
      );
    const response = await fetcher(input, init);
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const seconds = retry ? Number(retry) : NaN;
      const delay = Number.isFinite(seconds)
        ? seconds * 1_000
        : retry
        ? Date.parse(retry) - now()
        : 30_000;
      cooldowns.set(
        endpoint,
        now() + Math.max(30_000, Number.isFinite(delay) ? delay : 30_000)
      );
      throw new Error(
        "Devnet RPC is rate limited (429). Retrying after a short pause."
      );
    }
    return response;
  };
}
export const rpcFetch = createRpcFetch((input, init) => fetch(input, init));
