import { Connection } from "@solana/web3.js";

async function rpcRequest(
  connection: Connection,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as {
    result?: unknown;
    error?: { message: string };
  };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

/**
 * Advance the surfnet clock when Surfpool is the RPC. `absoluteTimestamp` is in
 * milliseconds; the Clock sysvar the program reads is in seconds.
 */
export async function warpToUnixTime(
  connection: Connection,
  unixTimestamp: number,
): Promise<void> {
  await rpcRequest(connection, "surfnet_timeTravel", [
    { absoluteTimestamp: unixTimestamp * 1000 },
  ]);
}
