import { v } from "convex/values";
import { internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { CHALLENGE_TTL_MS, SESSION_MAX_MS } from "../lib/auth/siws";

const MAX_OPEN_CHALLENGES = 5;

export const createChallenge = internalMutation({
  args: { wallet: v.string(), domain: v.string(), network: v.string(), nonce: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const open = await ctx.db
      .query("authChallenges")
      .withIndex("by_wallet", (q) => q.eq("wallet", args.wallet).gt("expiresAt", now))
      .take(MAX_OPEN_CHALLENGES + 1);
    if (open.filter((c) => c.usedAt === undefined).length >= MAX_OPEN_CHALLENGES) return null;
    const challenge = { ...args, issuedAt: now, expiresAt: now + CHALLENGE_TTL_MS };
    await ctx.db.insert("authChallenges", challenge);
    return challenge;
  },
});

export const getChallenge = internalQuery({
  args: { nonce: v.string() },
  handler: (ctx, { nonce }) => ctx.db.query("authChallenges").withIndex("by_nonce", (q) => q.eq("nonce", nonce)).unique(),
});

/** Atomically marks the challenge used and opens a session. A second caller with the same nonce gets null. */
export const consumeChallenge = internalMutation({
  args: { nonce: v.string(), wallet: v.string(), domain: v.string() },
  handler: async (ctx, { nonce, wallet, domain }) => {
    const now = Date.now();
    const c = await ctx.db.query("authChallenges").withIndex("by_nonce", (q) => q.eq("nonce", nonce)).unique();
    if (!c || c.usedAt !== undefined || now >= c.expiresAt || c.wallet !== wallet || c.domain !== domain) return null;
    await ctx.db.patch(c._id, { usedAt: now });
    return await ctx.db.insert("sessions", { wallet, domain, createdAt: now, expiresAt: now + SESSION_MAX_MS });
  },
});

export const activeSession = internalQuery({
  args: { sid: v.string(), wallet: v.string() },
  handler: async (ctx, { sid, wallet }) => {
    const id = ctx.db.normalizeId("sessions", sid);
    if (!id) return false;
    const s = await ctx.db.get(id);
    return !!s && s.wallet === wallet && s.revokedAt === undefined && Date.now() < s.expiresAt;
  },
});

export const revokeSession = internalMutation({
  args: { sid: v.string(), wallet: v.string() },
  handler: async (ctx, { sid, wallet }) => {
    const id = ctx.db.normalizeId("sessions", sid);
    const s = id && (await ctx.db.get(id));
    if (s && s.wallet === wallet && s.revokedAt === undefined) await ctx.db.patch(s._id, { revokedAt: Date.now() });
  },
});

export const recordFailure = internalMutation({
  args: { reason: v.string() },
  handler: async (ctx, { reason }) => {
    await ctx.db.insert("authFailures", { reason, at: Date.now() });
  },
});

export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db.query("authChallenges").withIndex("by_expiry", (q) => q.lt("expiresAt", now - 60 * 60_000)).take(500);
    for (const c of stale) await ctx.db.delete(c._id);
    const failures = await ctx.db.query("authFailures").withIndex("by_at", (q) => q.lt("at", now - 30 * 86_400_000)).take(500);
    for (const f of failures) await ctx.db.delete(f._id);
  },
});

/**
 * The only way a Convex function learns who is calling. It trusts the verified token subject and
 * re-checks the session row, so a revoked session stops working before its token expires.
 */
export async function requireWallet(ctx: QueryCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not signed in");
  const sid = (identity as unknown as { sid?: string }).sid;
  const id = typeof sid === "string" ? ctx.db.normalizeId("sessions", sid) : null;
  const s = id ? await ctx.db.get(id as Id<"sessions">) : null;
  if (!s || s.wallet !== identity.subject || s.revokedAt !== undefined || Date.now() >= s.expiresAt) throw new Error("Session ended");
  return identity.subject;
}

/** Lets the client confirm that Convex sees the same wallet it signed in with. */
export const whoami = query({
  args: {},
  handler: async (ctx) => {
    try {
      return { wallet: await requireWallet(ctx) };
    } catch {
      return null;
    }
  },
});
