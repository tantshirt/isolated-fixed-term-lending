"use node";

import { Connection, Keypair } from "@solana/web3.js";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { runKeeperOnce } from "../lib/v2/keeper";
import { decodePriceUpdateV2 } from "../lib/server/price-update-codec";
import { PYTH_PRICE_UPDATE_ACCOUNT, MAX_PRICE_AGE_SECONDS } from "../lib/constants";
import { refreshPyth } from "../scripts/pyth-refresh";

/**
 * Reference liquidator pass. Runs only when KEEPER_ENABLED=1 and KEEPER_SECRET holds the
 * operator keypair, funded with operator-owned Devnet USDC.
 */
export const run = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    if (process.env.KEEPER_ENABLED !== "1" || !process.env.KEEPER_SECRET) return;
    const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEEPER_SECRET)));
    const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
    const readPrice = async () => {
      const info = await connection.getAccountInfo(PYTH_PRICE_UPDATE_ACCOUNT);
      if (!info) return null;
      const d = decodePriceUpdateV2(info.data as Buffer);
      const now = Math.floor(Date.now() / 1000);
      const publishTime = Number(d.publishTime);
      return {
        price: d.price,
        conf: d.conf,
        exponent: d.exponent,
        publishTime,
        fresh: now - publishTime <= MAX_PRICE_AGE_SECONDS - 10,
        ema: d.emaPrice !== undefined && d.emaConf !== undefined ? { price: d.emaPrice, conf: d.emaConf } : undefined,
      };
    };
    const result = await runKeeperOnce({
      connection,
      keeper,
      priceAccount: PYTH_PRICE_UPDATE_ACCOUNT,
      readPrice,
      postPrice: async () => {
        await refreshPyth(connection, keeper);
      },
      recordSignature: async (offer, signature, lastValidBlockHeight) => {
        await ctx.runMutation(internal.keeperData.record, { offer, result: "sent", signature, lastValidBlockHeight });
      },
      spentInWindow: BigInt(await ctx.runQuery(internal.keeperData.spentInWindow, {})),
      now: () => Math.floor(Date.now() / 1000),
    });
    for (const o of result.outcomes) await ctx.runMutation(internal.keeperData.record, { offer: o.offer, result: o.result, signature: o.signature, payoff: o.payoff });
    await ctx.runMutation(internal.keeperData.capital, { usdc: result.usdcBalance, scanned: result.scanned });
  },
});
