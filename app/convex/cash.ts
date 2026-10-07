import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireWallet } from "./auth";
import { CASH_OUT_TERMINAL } from "../lib/cash/moneygram";

const env = () => (process.env.MONEYGRAM_ENV === "production" ? ("production" as const) : ("sandbox" as const));

/** From the widget's onTransactionCreated: persist the stable ids before anything moves. */
export const recordCreated = mutation({
  args: { rampsId: v.string(), mgiTransactionId: v.optional(v.string()), amount: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const wallet = await requireWallet(ctx);
    const existing = await ctx.db.query("cashTransactions").withIndex("by_ramps", (q) => q.eq("rampsId", a.rampsId)).unique();
    if (existing) {
      if (existing.wallet !== wallet) throw new Error("Not your cash-out");
      if (a.mgiTransactionId && !existing.mgiTransactionId) await ctx.db.patch(existing._id, { mgiTransactionId: a.mgiTransactionId, updatedAt: Date.now() });
      return existing._id;
    }
    const now = Date.now();
    return ctx.db.insert("cashTransactions", { wallet, env: env(), rampsId: a.rampsId, mgiTransactionId: a.mgiTransactionId, status: "created", createdAt: now, updatedAt: now });
  },
});

/** After the wallet signed the reviewed transfer: the signature and what was reviewed. */
export const recordSigned = mutation({
  args: { rampsId: v.string(), signature: v.string(), amountAtoms: v.string(), depositAddress: v.string() },
  handler: async (ctx, a) => {
    const wallet = await requireWallet(ctx);
    const row = await ctx.db.query("cashTransactions").withIndex("by_ramps", (q) => q.eq("rampsId", a.rampsId)).unique();
    if (!row || row.wallet !== wallet) throw new Error("Not your cash-out");
    await ctx.db.patch(row._id, { signature: a.signature, amountAtoms: a.amountAtoms, depositAddress: a.depositAddress, status: row.status === "created" ? "awaiting_funds" : row.status, updatedAt: Date.now() });
  },
});

export const recordReference = mutation({
  args: { rampsId: v.string(), referenceNumber: v.string() },
  handler: async (ctx, a) => {
    const wallet = await requireWallet(ctx);
    const row = await ctx.db.query("cashTransactions").withIndex("by_ramps", (q) => q.eq("rampsId", a.rampsId)).unique();
    if (!row || row.wallet !== wallet) throw new Error("Not your cash-out");
    await ctx.db.patch(row._id, { referenceNumber: a.referenceNumber.slice(0, 64), updatedAt: Date.now() });
  },
});

export const myCashOuts = query({
  args: {},
  handler: async (ctx) => {
    let wallet: string;
    try {
      wallet = await requireWallet(ctx);
    } catch {
      return null;
    }
    const rows = await ctx.db.query("cashTransactions").withIndex("by_wallet", (q) => q.eq("wallet", wallet)).order("desc").take(20);
    return rows.map((r) => ({ rampsId: r.rampsId, status: r.status, amountAtoms: r.amountAtoms ?? null, referenceNumber: r.referenceNumber ?? null, signature: r.signature ?? null, updatedAt: r.updatedAt }));
  },
});

/** Marks a webhook delivery as handled; false when this (id, status) was already seen. */
export const claimEvent = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    if (await ctx.db.query("moneygramEvents").withIndex("by_key", (q) => q.eq("key", key)).unique()) return false;
    await ctx.db.insert("moneygramEvents", { key, receivedAt: Date.now() });
    return true;
  },
});

export const byMgi = internalQuery({
  args: { mgiTransactionId: v.string() },
  handler: (ctx, { mgiTransactionId }) => ctx.db.query("cashTransactions").withIndex("by_mgi", (q) => q.eq("mgiTransactionId", mgiTransactionId)).unique(),
});

export const byRamps = internalQuery({
  args: { rampsId: v.string() },
  handler: (ctx, { rampsId }) => ctx.db.query("cashTransactions").withIndex("by_ramps", (q) => q.eq("rampsId", rampsId)).unique(),
});

export const setStatus = internalMutation({
  args: { rampsId: v.string(), status: v.string(), referenceNumber: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("cashTransactions").withIndex("by_ramps", (q) => q.eq("rampsId", a.rampsId)).unique();
    if (!row) return;
    const now = Date.now();
    await ctx.db.patch(row._id, { status: a.status, lastCheckedAt: now, updatedAt: a.status === row.status ? row.updatedAt : now, ...(a.referenceNumber ? { referenceNumber: a.referenceNumber } : {}) });
  },
});

/** Cash-outs still in flight, for the fallback poll and the stuck-session monitor. */
export const open = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("cashTransactions").order("desc").take(200);
    return rows.filter((r) => !CASH_OUT_TERMINAL.has(r.status));
  },
});
