import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";

const WINDOW_MS = 24 * 60 * 60_000;
const MAX_ROWS = 1_000;
const pendingResults = ["pending-risk", "pending-overdue", "sent"] as const;
const isPending = (result: string) => pendingResults.some((r) => r === result);

async function pendingRows(ctx: Pick<QueryCtx, "db">) {
  const groups = await Promise.all(pendingResults.map((result) => ctx.db.query("keeperRuns").withIndex("by_result", (q) => q.eq("result", result)).take(MAX_ROWS + 1)));
  if (groups.some((rows) => rows.length > MAX_ROWS)) throw new Error("Keeper reconciliation backlog exceeds its safe scan limit.");
  return groups.flat();
}

async function budgetUsed(ctx: Pick<QueryCtx, "db">): Promise<bigint> {
  const [pending, ...settledGroups] = await Promise.all([
    pendingRows(ctx),
    ...["settled-risk", "settled-overdue"].map((result) => ctx.db.query("keeperRuns").withIndex("by_result_at", (q) => q.eq("result", result).gte("at", Date.now() - WINDOW_MS)).take(MAX_ROWS + 1)),
  ]);
  const recent = settledGroups.flat();
  if (settledGroups.some((rows) => rows.length > MAX_ROWS)) throw new Error("Keeper history exceeds its safe budget scan limit.");
  // Pending signatures keep their reservation even when older than the rolling window.
  // Legacy sent rows had no amount: conservatively hold the original per-action cap.
  return [...pending, ...recent.filter((r) => r.result.startsWith("settled"))]
    .reduce((total, r) => total + BigInt(r.payoff ?? "50000000"), 0n);
}

export const spentInWindow = internalQuery({
  args: {}, returns: v.string(),
  handler: async (ctx) => (await budgetUsed(ctx)).toString(),
});

export const pending = internalQuery({
  args: {},
  returns: v.array(v.object({ signature: v.string(), lastValidBlockHeight: v.number(), kind: v.union(v.literal("risk"), v.literal("overdue")) })),
  handler: async (ctx) => (await pendingRows(ctx)).map((r) => {
    if (!r.signature || r.lastValidBlockHeight === undefined) throw new Error("An unresolved keeper record lacks its signed transaction identity.");
    return { signature: r.signature, lastValidBlockHeight: r.lastValidBlockHeight, kind: r.result === "pending-risk" ? "risk" as const : "overdue" as const };
  }),
});

/** Atomic admission prevents overlapping passes from spending the same budget or loan twice. */
export const reserve = internalMutation({
  args: { offer: v.string(), signature: v.string(), lastValidBlockHeight: v.number(), payoff: v.string(), kind: v.union(v.literal("risk"), v.literal("overdue")), maxPerAction: v.string(), totalCapital: v.string() },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    const amount = BigInt(a.payoff);
    if (amount <= 0n || amount > BigInt(a.maxPerAction)) return false;
    if (await ctx.db.query("keeperRuns").withIndex("by_signature", (q) => q.eq("signature", a.signature)).first()) return false;
    if ((await pendingRows(ctx)).some((r) => r.offer === a.offer)) return false;
    if (await budgetUsed(ctx) + amount > BigInt(a.totalCapital)) return false;
    await ctx.db.insert("keeperRuns", { at: Date.now(), offer: a.offer, signature: a.signature, lastValidBlockHeight: a.lastValidBlockHeight, payoff: a.payoff, result: `pending-${a.kind}` });
    return true;
  },
});

/** Idempotent terminal transition; repeated reconciliations never double-count a payment. */
export const resolve = internalMutation({
  args: { signature: v.string(), result: v.union(v.literal("settled-risk"), v.literal("settled-overdue"), v.literal("failed-chain"), v.literal("expired")) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("keeperRuns").withIndex("by_signature", (q) => q.eq("signature", a.signature)).first();
    if (row && isPending(row.result)) {
      // The old sender appended a separate settled row after its `sent` row. Preserve that
      // original charge instead of accounting for the same historical signature twice.
      const previous = row.result === "sent"
        ? await ctx.db.query("keeperRuns").withIndex("by_signature", (q) => q.eq("signature", a.signature)).take(10)
        : [];
      const alreadyCounted = previous.some((r) => r.result.startsWith("settled"));
      await ctx.db.patch(row._id, { result: alreadyCounted ? "reconciled" : a.result, at: Date.now(), payoff: row.payoff ?? "50000000" });
    }
    return null;
  },
});

export const record = internalMutation({
  args: { offer: v.string(), result: v.string(), signature: v.optional(v.string()), lastValidBlockHeight: v.optional(v.number()), payoff: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    await ctx.db.insert("keeperRuns", { ...a, at: Date.now() });
    return null;
  },
});

export const capital = internalMutation({
  args: { usdc: v.string(), scanned: v.number() }, returns: v.null(),
  handler: async (ctx, a) => {
    await ctx.db.insert("keeperCapital", { ...a, at: Date.now() });
    return null;
  },
});

export const status = internalQuery({
  args: {},
  returns: v.object({ usdc: v.union(v.string(), v.null()), lastScanAt: v.union(v.number(), v.null()), settled: v.number(), failures: v.number(), depleted: v.boolean() }),
  handler: async (ctx) => {
    const last = await ctx.db.query("keeperCapital").withIndex("by_at").order("desc").first();
    const recent = await ctx.db.query("keeperRuns").withIndex("by_at", (q) => q.gte("at", Date.now() - WINDOW_MS)).order("desc").take(MAX_ROWS);
    return {
      usdc: last?.usdc ?? null, lastScanAt: last?.at ?? null,
      settled: recent.filter((r) => r.result.startsWith("settled")).length,
      failures: recent.filter((r) => /^(failed|error|simulation)/.test(r.result)).length,
      depleted: recent.some((r) => r.result === "no-funds" || r.result === "over-capital"),
    };
  },
});
