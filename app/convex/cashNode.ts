"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { RAMPS, type RampsEnv } from "../lib/cash/moneygram";
import { providerAllowed } from "../lib/ops-flags";

const env = () => (process.env.MONEYGRAM_ENV === "production" ? ("production" as const) : ("sandbox" as const));

/** A server-created Ramps session for one wallet. The secret key never leaves Convex. */
export async function createRampsSession(walletAddress: string, targetEnv: RampsEnv = env()): Promise<{ sessionToken: string; sessionId: string; widgetUrl: string }> {
  const key = process.env.RAMPS_SECRET_KEY;
  if (!key) throw new Error("MoneyGram is not connected on this deployment.");
  const res = await fetch(`${RAMPS[targetEnv].base}/api/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ walletAddress, chain: "solana" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`MoneyGram session failed (${res.status}).`);
  const data = (await res.json()) as { sessionToken: string; sessionId: string; widgetUrl: string };
  return { sessionToken: data.sessionToken, sessionId: data.sessionId, widgetUrl: data.widgetUrl };
}

export const session = internalAction({
  args: { wallet: v.string() },
  returns: v.object({ sessionToken: v.string(), sessionId: v.string(), widgetUrl: v.string() }),
  handler: async (ctx, { wallet }): Promise<{ sessionToken: string; sessionId: string; widgetUrl: string }> => {
    const allowed = providerAllowed("moneygram", await ctx.runQuery(api.ops.flags, {}));
    if (!allowed.allowed) throw new Error(allowed.reason);
    return createRampsSession(wallet);
  },
});

/**
 * Authoritative status: GET /v1/transactions/{id}/status?sync=true with a fresh session for the
 * transaction's wallet (session tokens last an hour, so one is never stored).
 */
export const reconcile = internalAction({
  args: { rampsId: v.string() },
  handler: async (ctx, { rampsId }): Promise<void> => {
    const row: Doc<"cashTransactions"> | null = await ctx.runQuery(internal.cash.byRamps, { rampsId });
    if (!row) return;
    const { sessionToken } = await createRampsSession(row.wallet, row.env);
    const res = await fetch(`${RAMPS[row.env].base}/api/v1/transactions/${encodeURIComponent(rampsId)}/status?sync=true`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`MoneyGram status failed (${res.status}).`);
    const data = (await res.json()) as { status?: string; referenceNumber?: string };
    if (typeof data.status === "string") await ctx.runMutation(internal.cash.setStatus, { rampsId, status: data.status, referenceNumber: data.referenceNumber });
  },
});

/** Fallback where webhooks are not enabled: reconcile in-flight cash-outs every few minutes. */
export const poll = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    if (!process.env.RAMPS_SECRET_KEY) return;
    const open: Doc<"cashTransactions">[] = await ctx.runMutation(internal.cash.claimPollBatch, {});
    for (const row of open) {
      await ctx.runAction(internal.cashNode.reconcile, { rampsId: row.rampsId }).catch(() => {});
    }
  },
});
