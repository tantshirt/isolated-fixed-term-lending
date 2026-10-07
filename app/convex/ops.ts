import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireWallet } from "./auth";
import { crankParity, type CrankObservation } from "../lib/jobs/crank-parity";
import type { OpsFlag } from "../lib/ops-flags";

const FLAG_KEYS = ["originations", "provider:zenlo-public", "provider:zenlo-private", "provider:moneygram", "provider:telegram", "provider:umbra"];

function opsAdmins(): Set<string> {
  return new Set((process.env.OPS_ADMIN_WALLETS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

/** Public: the interface reads pauses to explain why an originating action is unavailable. */
export const flags = query({
  args: {},
  handler: async (ctx): Promise<OpsFlag[]> => {
    const rows = await ctx.db.query("opsFlags").collect();
    return rows.map((r) => ({ key: r.key as OpsFlag["key"], paused: r.paused, reason: r.reason }));
  },
});

/** Only signed-in operations wallets listed in OPS_ADMIN_WALLETS can pause or resume. */
export const setFlag = mutation({
  args: { key: v.string(), paused: v.boolean(), reason: v.optional(v.string()) },
  handler: async (ctx, { key, paused, reason }) => {
    const wallet = await requireWallet(ctx);
    if (!opsAdmins().has(wallet)) throw new Error("Not an operations wallet");
    if (!FLAG_KEYS.includes(key)) throw new Error("Unknown flag");
    const existing = await ctx.db.query("opsFlags").withIndex("by_key", (q) => q.eq("key", key)).unique();
    const row = { key, paused, reason: reason?.slice(0, 200), updatedBy: wallet, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("opsFlags", row);
  },
});

export const recordCrank = internalMutation({
  args: {
    source: v.union(v.literal("live"), v.literal("shadow")),
    slot: v.string(),
    due: v.array(v.string()),
    triggered: v.array(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await ctx.db.insert("crankObservations", { ...a, at: Date.now() });
  },
});

export const recordOracle = internalMutation({
  args: { publishTime: v.optional(v.number()), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await ctx.db.insert("oracleSamples", { ...a, at: Date.now() });
  },
});

/** Parity over a window, used to decide the cranker cutover (zero misses for seven days). */
export const parity = internalQuery({
  args: { sinceMs: v.number() },
  handler: async (ctx, { sinceMs }) => {
    const now = Date.now();
    const rows = await ctx.db.query("crankObservations").withIndex("by_at", (q) => q.gte("at", now - sinceMs)).collect();
    const obs: CrankObservation[] = rows.filter((r) => !r.error).map((r) => ({ source: r.source, at: r.at, due: r.due, triggered: r.triggered }));
    return { ...crankParity(obs, now), errors: rows.filter((r) => r.error).length };
  },
});

/** The monitored signals from Story 19.3. Provider sessions join this when providers ship. */
export const health = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const oldestQueued = await ctx.db.query("jobs").withIndex("by_status_next", (q) => q.eq("status", "queued").lte("nextRunAt", now)).first();
    const uncertain = await ctx.db.query("jobs").withIndex("by_status_next", (q) => q.eq("status", "uncertain")).take(100);
    const failed = await ctx.db.query("jobs").withIndex("by_status_next", (q) => q.eq("status", "failed")).take(100);
    const lastShadow = await ctx.db.query("crankObservations").withIndex("by_at").order("desc").filter((q) => q.eq(q.field("source"), "shadow")).first();
    const lastLive = await ctx.db.query("crankObservations").withIndex("by_at").order("desc").filter((q) => q.eq(q.field("source"), "live")).first();
    const oracle = await ctx.db.query("oracleSamples").withIndex("by_at").order("desc").first();
    const authFailures = await ctx.db.query("authFailures").withIndex("by_at", (q) => q.gte("at", now - 3_600_000)).take(1000);
    const byReason: Record<string, number> = {};
    for (const f of authFailures) byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
    return {
      at: now,
      jobLagMs: oldestQueued ? now - oldestQueued.nextRunAt : 0,
      uncertainJobs: uncertain.length,
      failedJobs: failed.length,
      watchLagMs: { shadow: lastShadow ? now - lastShadow.at : null, live: lastLive ? now - lastLive.at : null },
      oracleAgeS: oracle?.publishTime ? Math.round(oracle.at / 1000 - oracle.publishTime) : null,
      oracleError: oracle?.error ?? null,
      authFailuresLastHour: byReason,
      // A cash-out with no status change for two hours, not yet terminal, needs a look.
      stuckProviderSessions: (await ctx.db.query("cashTransactions").order("desc").take(200)).filter(
        (r) => !["paid_out", "failed", "quote_expired", "refunded", "refund_failed"].includes(r.status) && now - r.updatedAt > 2 * 3_600_000,
      ).length,
      keeper: await (async () => {
        const last = await ctx.db.query("keeperCapital").withIndex("by_at").order("desc").first();
        const runs = await ctx.db.query("keeperRuns").withIndex("by_at", (q) => q.gte("at", now - 86_400_000)).take(500);
        return {
          usdc: last?.usdc ?? null,
          lastScanAt: last?.at ?? null,
          settled: runs.filter((r) => r.result.startsWith("settled")).length,
          failures: runs.filter((r) => /^(failed|error|simulation)/.test(r.result)).length,
          depleted: runs.some((r) => r.result === "no-funds" || r.result === "over-capital"),
        };
      })(),
    };
  },
});

export const purgeObservations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 86_400_000;
    for (const table of ["crankObservations", "oracleSamples"] as const) {
      const old = await ctx.db.query(table).withIndex("by_at", (q) => q.lt("at", cutoff)).take(1000);
      for (const r of old) await ctx.db.delete(r._id);
    }
  },
});
