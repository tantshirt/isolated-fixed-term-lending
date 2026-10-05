import { assertLocalControls } from "./local-guard";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { PYTH_RECEIVER_PROGRAM_ID, SOL_USD_FEED_ID } from "../constants";
import { encodePriceUpdateV2 } from "./price-update-codec";

export type MockPriceParams = {
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime?: number;
};

/** Default worked-example SOL/USD: 150.00 ± 0.15, exponent -8. */
export function defaultMockPrice(): MockPriceParams {
  return {
    price: 15_000_000_000n,
    conf: 15_000_000n,
    exponent: -8,
  };
}

/**
 * The program checks price age against the chain clock, not the wall clock.
 * Surfpool time travel makes the two drift, so always stamp from the chain.
 */
export async function chainUnixTime(connection: Connection): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  const time = await connection.getBlockTime(slot);
  if (time === null)
    throw new Error("Chain time is unavailable; retry the price read");
  return time;
}

export async function encodePriceUpdateV2Account(
  writeAuthority: PublicKey,
  params: MockPriceParams & { publishTime: number },
  postedSlot = 0n
): Promise<Buffer> {
  return encodePriceUpdateV2(
    writeAuthority,
    {
      feedId: SOL_USD_FEED_ID,
      price: params.price,
      conf: params.conf,
      exponent: params.exponent,
      publishTime: BigInt(params.publishTime),
    },
    postedSlot
  );
}

async function rpcRequest(
  connection: Connection,
  method: string,
  params: unknown[]
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

/** Surfpool / surfnet cheatcode when available; otherwise false. */
export async function trySurfnetSetAccount(
  connection: Connection,
  pubkey: PublicKey,
  data: Buffer,
  lamports = 2_000_000_000
): Promise<boolean> {
  assertLocalControls();
  try {
    await rpcRequest(connection, "surfnet_setAccount", [
      pubkey.toBase58(),
      {
        lamports,
        owner: PYTH_RECEIVER_PROGRAM_ID.toBase58(),
        // Surfpool 1.x takes account data as a hex string.
        data: data.toString("hex"),
        executable: false,
      },
    ]);
    return true;
  } catch (err) {
    console.warn(
      "surfnet_setAccount failed:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

export async function ensurePriceUpdateAccount(
  connection: Connection,
  payer: Keypair,
  priceUpdateKeypair: Keypair,
  writeAuthority: Keypair,
  params: MockPriceParams
): Promise<PublicKey> {
  const data = await encodePriceUpdateV2Account(writeAuthority.publicKey, {
    ...params,
    publishTime: params.publishTime ?? (await chainUnixTime(connection)),
  });
  const space = data.length;
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  const info = await connection.getAccountInfo(priceUpdateKeypair.publicKey);

  if (!info) {
    const created = await trySurfnetSetAccount(
      connection,
      priceUpdateKeypair.publicKey,
      data,
      lamports + 1_000_000
    );
    if (!created) {
      throw new Error(
        "Could not create mock Pyth account. Start Surfpool/surfnet or clone the Pyth receiver on your validator, then call setup again."
      );
    }
    return priceUpdateKeypair.publicKey;
  }

  const updated = await trySurfnetSetAccount(
    connection,
    priceUpdateKeypair.publicKey,
    data,
    info.lamports
  );
  if (!updated) {
    throw new Error(
      "Could not rewrite mock Pyth account. Use Surfpool (surfnet_setAccount) or post a Hermes update."
    );
  }
  return priceUpdateKeypair.publicKey;
}

export async function fundKeypair(
  connection: Connection,
  payer: Keypair,
  target: PublicKey,
  lamports = 2 * 10 ** 9
): Promise<void> {
  const sig = await connection.requestAirdrop(target, lamports);
  await connection.confirmTransaction(sig, "confirmed");
}

export { SystemProgram };
