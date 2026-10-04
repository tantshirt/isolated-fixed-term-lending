import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { MAX_PRICE_AGE_SECONDS, RPC_URL } from "@/lib/constants";
import { readDevConfig } from "@/lib/server/dev-config";
import { readDevSecrets } from "@/lib/server/dev-secrets";
import {
  chainUnixTime,
  encodePriceUpdateV2Account,
  trySurfnetSetAccount,
} from "@/lib/server/pyth-mock";
import { decodePriceUpdateV2 } from "@/lib/server/price-update-codec";

export const runtime = "nodejs";

/** Re-stamp the mock once it is this old, so a local demo never sits on a stale price. */
const KEEP_FRESH_AFTER_SECONDS = 30;

/**
 * Freshness is judged on the chain clock, the same clock the program uses.
 * `?keepFresh=1` re-posts the same price with a new timestamp (local mock only).
 */
export async function GET(request: Request) {
  try {
    const config = await readDevConfig();
    if (!config) {
      return NextResponse.json({ error: "Run local setup first" }, { status: 400 });
    }
    const keepFresh = new URL(request.url).searchParams.get("keepFresh") === "1";
    const connection = new Connection(RPC_URL, "confirmed");
    const account = new PublicKey(config.priceUpdateAccount);

    const info = await connection.getAccountInfo(account);
    if (!info?.data) {
      return NextResponse.json({ error: "No price account" }, { status: 404 });
    }
    let decoded = decodePriceUpdateV2(info.data);
    const now = await chainUnixTime(connection);

    const age = now - Number(decoded.publishTime);
    if (keepFresh && age > KEEP_FRESH_AFTER_SECONDS) {
      const secrets = await readDevSecrets();
      if (secrets) {
        const writeAuthority = Keypair.fromSecretKey(
          Uint8Array.from(secrets.priceWriteAuthoritySecret),
        );
        const { price, conf, exponent } = decoded;
        const data = await encodePriceUpdateV2Account(writeAuthority.publicKey, {
          price,
          conf,
          exponent,
          publishTime: now,
        });
        if (await trySurfnetSetAccount(connection, account, data, info.lamports)) {
          decoded = decodePriceUpdateV2(data);
        }
      }
    }

    const publishTime = Number(decoded.publishTime);
    return NextResponse.json({
      price: decoded.price.toString(),
      conf: decoded.conf.toString(),
      exponent: decoded.exponent,
      publishTime,
      chainTime: now,
      fresh: now - publishTime <= MAX_PRICE_AGE_SECONDS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "price read failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
