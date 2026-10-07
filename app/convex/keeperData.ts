import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const WINDOW_MS = 24 * 60 * 60_000;

export const spentInWindow = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("keeperRuns").withIndex("by_at", (q) => q.gte("at", Date.now() - WINDOW_MS)).collect();
    return rows.filter((r) => r.result.startsWith("settled") && r.payoff).reduce((t, r) => t + BigInt(r.payoff!), 0n).toString();
  },
});

export const record = internalMutation({
  args: { offer: v.string(), result: v.string(), signature: v.optional(v.string()), lastValidBlockHeight: v.optional(v.number()), payoff: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await ctx.db.insert("keeperRuns", { ...a, at: Date.now() });
  },
});

export const capital = internalMutation({
  args: { usdc: v.string(), scanned: v.number() },
  handler: async (ctx, a) => {
    await ctx.db.insert("keeperCapital", { ...a, at: Date.now() });
  },
});

export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const last = await ctx.db.query("keeperCapital").withIndex("by_at").order("desc").first();
    const recent = await ctx.db.query("keeperRuns").withIndex("by_at", (q) => q.gte("at", Date.now() - WINDOW_MS)).collect();
    return {
      usdc: last?.usdc ?? null,
      lastScanAt: last?.at ?? null,
      settled: recent.filter((r) => r.result.startsWith("settled")).length,
      failures: recent.filter((r) => /^(failed|error|simulation)/.test(r.result)).length,
      depleted: recent.some((r) => r.result === "no-funds" || r.result === "over-capital"),
    };
  },
});
