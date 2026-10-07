import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireWallet } from "./auth";
import { newNonce } from "../lib/auth/siws";

const LINK_TTL_MS = 10 * 60_000;
const MAX_SUBSCRIPTIONS = 50;

/** A one-use deep link for the signed-in wallet. Opening it in Telegram links that chat. */
export const createTelegramLink = mutation({
  args: {},
  handler: async (ctx) => {
    const wallet = await requireWallet(ctx);
    const bot = process.env.TELEGRAM_BOT_USERNAME;
    if (!bot) throw new Error("Telegram alerts are not connected on this deployment.");
    const nonce = newNonce().slice(0, 32);
    await ctx.db.insert("telegramLinkTokens", { nonce, wallet, expiresAt: Date.now() + LINK_TTL_MS });
    return { url: `https://t.me/${bot}?start=${nonce}`, expiresAt: Date.now() + LINK_TTL_MS };
  },
});

/** Called by the webhook for `/start <nonce>`. Returns the wallet linked, or null. */
export const consumeTelegramNonce = internalMutation({
  args: { nonce: v.string(), chatId: v.string() },
  handler: async (ctx, { nonce, chatId }) => {
    const t = await ctx.db.query("telegramLinkTokens").withIndex("by_nonce", (q) => q.eq("nonce", nonce)).unique();
    if (!t || t.usedAt !== undefined || Date.now() >= t.expiresAt) return null;
    await ctx.db.patch(t._id, { usedAt: Date.now() });
    for (const old of await ctx.db.query("telegramChats").withIndex("by_wallet", (q) => q.eq("wallet", t.wallet)).collect()) await ctx.db.delete(old._id);
    for (const old of await ctx.db.query("telegramChats").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()) await ctx.db.delete(old._id);
    await ctx.db.insert("telegramChats", { wallet: t.wallet, chatId, linkedAt: Date.now() });
    return t.wallet;
  },
});

export const unlinkTelegram = mutation({
  args: {},
  handler: async (ctx) => {
    const wallet = await requireWallet(ctx);
    for (const c of await ctx.db.query("telegramChats").withIndex("by_wallet", (q) => q.eq("wallet", wallet)).collect()) await ctx.db.delete(c._id);
  },
});

export const myAlerts = query({
  args: {},
  handler: async (ctx) => {
    let wallet: string;
    try {
      wallet = await requireWallet(ctx);
    } catch {
      return null;
    }
    const chat = await ctx.db.query("telegramChats").withIndex("by_wallet", (q) => q.eq("wallet", wallet)).first();
    const subs = await ctx.db.query("alertSubscriptions").withIndex("by_wallet", (q) => q.eq("wallet", wallet)).collect();
    return {
      telegramLinked: !!chat,
      subscriptions: subs.filter((s) => s.active).map((s) => ({ id: s._id, kind: s.kind, loan: s.loan, risk: s.risk, level: (s.state as { level?: number } | undefined)?.level ?? 0 })),
    };
  },
});

/**
 * Consent to monitoring for one loan. Private loans may share deadlines only; their risk band is
 * never computed on the server because the server cannot read their terms.
 */
export const subscribe = mutation({
  args: {
    kind: v.union(v.literal("public-v1"), v.literal("public-v2"), v.literal("private")),
    loan: v.string(),
    deadlines: v.optional(v.object({ maturity: v.number(), graceEnd: v.optional(v.number()), pricedFrom: v.optional(v.number()), terminalFrom: v.optional(v.number()) })),
  },
  handler: async (ctx, a) => {
    const wallet = await requireWallet(ctx);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.loan)) throw new Error("Not a loan address");
    if (a.kind === "private" && !a.deadlines) throw new Error("Private alerts need the deadlines you choose to share.");
    const existing = (await ctx.db.query("alertSubscriptions").withIndex("by_wallet", (q) => q.eq("wallet", wallet)).collect()).filter((s) => s.active);
    const same = existing.find((s) => s.loan === a.loan);
    if (same) return same._id;
    if (existing.length >= MAX_SUBSCRIPTIONS) throw new Error("Alert limit reached; remove one first.");
    return ctx.db.insert("alertSubscriptions", {
      wallet,
      kind: a.kind,
      loan: a.loan,
      risk: a.kind !== "private",
      deadlines: a.kind === "private" ? a.deadlines : undefined,
      active: true,
      consentedAt: Date.now(),
    });
  },
});

export const unsubscribe = mutation({
  args: { id: v.id("alertSubscriptions") },
  handler: async (ctx, { id }) => {
    const wallet = await requireWallet(ctx);
    const s = await ctx.db.get(id);
    if (!s || s.wallet !== wallet) throw new Error("Not your alert");
    await ctx.db.patch(id, { active: false, state: undefined, deadlines: undefined });
  },
});

export const activeSubscriptions = internalQuery({
  args: {},
  handler: async (ctx) => {
    const subs = await ctx.db.query("alertSubscriptions").withIndex("by_active", (q) => q.eq("active", true)).take(500);
    const out = [];
    for (const s of subs) {
      const chat = await ctx.db.query("telegramChats").withIndex("by_wallet", (q) => q.eq("wallet", s.wallet)).first();
      out.push({ ...s, chatId: chat?.chatId ?? null });
    }
    return out;
  },
});

export const saveState = internalMutation({
  args: { id: v.id("alertSubscriptions"), state: v.any() },
  handler: async (ctx, { id, state }) => {
    await ctx.db.patch(id, { state });
  },
});
