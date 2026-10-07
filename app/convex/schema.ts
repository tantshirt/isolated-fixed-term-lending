import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Operational data only. Private conversations, private books, raw income proofs and viewing keys
 * never belong here (AGENTS.md).
 */
export default defineSchema({
  authChallenges: defineTable({
    nonce: v.string(),
    wallet: v.string(),
    domain: v.string(),
    network: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_nonce", ["nonce"])
    .index("by_wallet", ["wallet", "expiresAt"])
    .index("by_expiry", ["expiresAt"]),

  sessions: defineTable({
    wallet: v.string(),
    domain: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  }).index("by_wallet", ["wallet"]),

  authFailures: defineTable({
    reason: v.string(),
    at: v.number(),
  }).index("by_at", ["at"]),
});
