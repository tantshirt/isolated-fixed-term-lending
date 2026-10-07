"use node";

import { Connection, Keypair } from "@solana/web3.js";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { findDueCranks, teeAs } from "../lib/server/cranker";
import { decodePriceUpdateV2 } from "../lib/server/price-update-codec";
import { PYTH_PRICE_UPDATE_ACCOUNT } from "../lib/constants";

/**
 * Shadow cranker: reads which watches are due, sends nothing. A throwaway keypair signs the TEE
 * sign-in, so the shadow needs no secret and is a member of no loan.
 */
export const shadowCrankScan = internalAction({
  args: {},
  handler: async (ctx) => {
    try {
      const er = await teeAs(Keypair.generate());
      const { slot, due } = await findDueCranks(er, 50);
      await ctx.runMutation(internal.ops.recordCrank, { source: "shadow", slot: slot.toString(), due: due.map((d) => d.crank.toBase58()), triggered: [] });
    } catch (e) {
      await ctx.runMutation(internal.ops.recordCrank, { source: "shadow", slot: "0", due: [], triggered: [], error: String(e).slice(0, 300) });
    }
  },
});

export const sampleOracle = internalAction({
  args: {},
  handler: async (ctx) => {
    try {
      const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
      const info = await conn.getAccountInfo(PYTH_PRICE_UPDATE_ACCOUNT);
      if (!info) throw new Error("price account missing");
      const decoded = decodePriceUpdateV2(info.data);
      await ctx.runMutation(internal.ops.recordOracle, { publishTime: Number(decoded.publishTime) });
    } catch (e) {
      await ctx.runMutation(internal.ops.recordOracle, { error: String(e).slice(0, 300) });
    }
  },
});
