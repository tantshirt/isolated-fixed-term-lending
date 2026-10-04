import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { RPC_URL } from "@/lib/constants";
import { readDevConfig } from "@/lib/server/dev-config";
import { readDevSecrets } from "@/lib/server/dev-secrets";
import {
  defaultMockPrice,
  chainUnixTime,
  encodePriceUpdateV2Account,
  trySurfnetSetAccount,
  type MockPriceParams,
} from "@/lib/server/pyth-mock";

export const runtime = "nodejs";

type Body = {
  priceUsd?: number;
  confUsd?: number;
  exponent?: number;
};

function paramsFromBody(body: Body): MockPriceParams {
  if (body.priceUsd == null) return defaultMockPrice();
  const exponent = body.exponent ?? -8;
  const scale = 10 ** -exponent;
  const price = BigInt(Math.round(body.priceUsd * scale));
  const conf = BigInt(
    Math.round((body.confUsd ?? body.priceUsd * 0.001) * scale),
  );
  return { price, conf, exponent };
}

export async function POST(request: Request) {
  try {
    const config = await readDevConfig();
    const secrets = await readDevSecrets();
    if (!config || !secrets) {
      return NextResponse.json({ error: "Run setup first" }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as Body;
    const params = paramsFromBody(body);
    const connection = new Connection(RPC_URL, "confirmed");

    const priceUpdate = new PublicKey(config.priceUpdateAccount);
    const writeAuthority = Keypair.fromSecretKey(
      Uint8Array.from(secrets.priceWriteAuthoritySecret),
    );
    const data = await encodePriceUpdateV2Account(writeAuthority.publicKey, {
      ...params,
      publishTime: await chainUnixTime(connection),
    });

    const info = await connection.getAccountInfo(priceUpdate);
    const lamports =
      info?.lamports ??
      (await connection.getMinimumBalanceForRentExemption(data.length)) +
        1_000_000;

    const ok = await trySurfnetSetAccount(
      connection,
      priceUpdate,
      data,
      lamports,
    );

    if (!ok) {
      return NextResponse.json(
        {
          error:
            "Could not rewrite mock Pyth account on this RPC. Start Surfpool/surfnet or post a Hermes Pyth update.",
        },
        { status: 501 },
      );
    }

    return NextResponse.json({
      ok: true,
      priceUpdate: config.priceUpdateAccount,
      priceUsd: body.priceUsd ?? 150,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "set-price failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
