/**
 * One reference-liquidator pass against Devnet, using the keeper key in ~/.config/zenlo/fixtures.
 * The same code runs every minute in Convex when KEEPER_ENABLED=1.
 *   npx tsx --env-file=.env.local scripts/keeper-once.ts --run
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  if (!process.argv.includes("--run")) throw new Error("This can submit Devnet transactions. Pass --run explicitly.");
  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
  const { Connection, Keypair } = await import("@solana/web3.js");
  const { runKeeperOnce } = await import("../lib/v2/keeper");
  const { decodePriceUpdateV2 } = await import("../lib/server/price-update-codec");
  const { PYTH_PRICE_UPDATE_ACCOUNT, MAX_PRICE_AGE_SECONDS } = await import("../lib/constants");
  const { refreshPyth } = await import("./pyth-refresh");
  const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/zenlo/fixtures/keeper.json"), "utf8"))));
  const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const result = await runKeeperOnce({
    connection,
    keeper,
    priceAccount: PYTH_PRICE_UPDATE_ACCOUNT,
    readPrice: async () => {
      const info = await connection.getAccountInfo(PYTH_PRICE_UPDATE_ACCOUNT);
      if (!info) return null;
      const d = decodePriceUpdateV2(info.data as Buffer);
      const publishTime = Number(d.publishTime);
      return { price: d.price, conf: d.conf, exponent: d.exponent, publishTime, fresh: Date.now() / 1000 - publishTime <= MAX_PRICE_AGE_SECONDS - 10, ema: d.emaPrice !== undefined ? { price: d.emaPrice, conf: d.emaConf! } : undefined };
    },
    postPrice: async () => void (await refreshPyth(connection, keeper)),
    recordSignature: async (offer, signature) => console.log(`sent ${signature} for ${offer}`),
    spentInWindow: 0n,
    now: () => Math.floor(Date.now() / 1000),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
