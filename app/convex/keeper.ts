"use node";

import { v } from "convex/values";
import { Connection, Keypair } from "@solana/web3.js";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { runKeeperOnce, reconcileKeeperTransactions, DEFAULT_KEEPER_LIMITS } from "../lib/v2/keeper";
import { decodePriceUpdateV2 } from "../lib/server/price-update-codec";
import { PYTH_PRICE_UPDATE_ACCOUNT, MAX_PRICE_AGE_SECONDS } from "../lib/constants";
import { refreshPyth } from "../scripts/pyth-refresh";
import { fetchMandates, mandateJobsDue } from "../lib/v2/mandates";
import { fetchOffersV2 } from "../lib/v2/offers";
import { mandatesEnabled } from "./lib/handlers";

/**
 * Story 26.3: finds public mandates needing execution or health rearming and queues one `mandate-execute` job for
 * each. A no-op unless MANDATES_ENABLED=1 and KEEPER_SECRET is set. Private mandates never appear
 * here: they live in the rollup and run in its crank.
 */
export const mandateScan = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    if (!mandatesEnabled()) return null;
    const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
    const mandates = await fetchMandates(connection);
    if (mandates.length === 0) return null;
    const offers = new Map((await fetchOffersV2(connection)).map((o) => [o.publicKey, o]));
    const info = await connection.getAccountInfo(PYTH_PRICE_UPDATE_ACCOUNT);
    const now = Math.floor(Date.now() / 1000);
    const d = info ? decodePriceUpdateV2(info.data as Buffer) : null;
    const price = d ? { price: d.price, conf: d.conf, exponent: d.exponent, publishTime: Number(d.publishTime), fresh: now - Number(d.publishTime) <= MAX_PRICE_AGE_SECONDS - 10 } : null;
    for (const job of mandateJobsDue(mandates, offers, price, now)) await ctx.runMutation(internal.jobs.enqueue, { kind: "mandate-execute", ...job });
    return null;
  },
});

/**
 * Reference liquidator pass. Runs only when KEEPER_ENABLED=1 and KEEPER_SECRET holds the
 * operator keypair, funded with operator-owned Devnet USDC.
 */
export const run = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    if (process.env.KEEPER_ENABLED !== "1" || !process.env.KEEPER_SECRET) return null;
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
    const recordOutcome = async (signature: string, result: string) => {
      if (result !== "settled-risk" && result !== "settled-overdue" && result !== "failed-chain" && result !== "expired") throw new Error("Invalid keeper outcome");
      await ctx.runMutation(internal.keeperData.resolve, { signature, result });
    };
    await reconcileKeeperTransactions(connection, await ctx.runQuery(internal.keeperData.pending, {}), recordOutcome);
    const result = await runKeeperOnce({
      connection,
      keeper,
      priceAccount: PYTH_PRICE_UPDATE_ACCOUNT,
      readPrice,
      postPrice: async () => {
        await refreshPyth(connection, keeper);
      },
      recordSignature: async (offer, signature, lastValidBlockHeight, payoff, kind) => ctx.runMutation(internal.keeperData.reserve, {
        offer, signature, lastValidBlockHeight, payoff, kind,
        maxPerAction: DEFAULT_KEEPER_LIMITS.maxPerAction.toString(), totalCapital: DEFAULT_KEEPER_LIMITS.totalCapital.toString(),
      }),
      recordOutcome,
      spentInWindow: BigInt(await ctx.runQuery(internal.keeperData.spentInWindow, {})),
      now: () => Math.floor(Date.now() / 1000),
    });
    for (const o of result.outcomes) if (!o.signature) await ctx.runMutation(internal.keeperData.record, { offer: o.offer, result: o.result, signature: o.signature, payoff: o.payoff });
    await ctx.runMutation(internal.keeperData.capital, { usdc: result.usdcBalance, scanned: result.scanned });
    return null;
  },
});
