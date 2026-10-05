import type { Connection } from "@solana/web3.js";
/** Read the chain independently of Pyth; a missing clock is never replaced by wall time. */
export async function readChainClock(
  connection: Pick<Connection, "getSlot" | "getBlockTime">
): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  const time = await connection.getBlockTime(slot);
  if (time === null || !Number.isSafeInteger(time) || time < 0)
    throw new Error("Chain time unavailable");
  return time;
}
