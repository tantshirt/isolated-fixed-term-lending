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

  /** Durable jobs (Story 19.3). Payloads hold operational references only, never private loan data. */
  jobs: defineTable({
    kind: v.string(),
    dedupKey: v.string(),
    payload: v.any(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("uncertain"), v.literal("succeeded"), v.literal("failed")),
    attempts: v.number(),
    maxAttempts: v.number(),
    nextRunAt: v.number(),
    leaseUntil: v.optional(v.number()),
    signature: v.optional(v.string()),
    lastValidBlockHeight: v.optional(v.number()),
    lastError: v.optional(v.string()),
    result: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_dedup", ["dedupKey"])
    .index("by_status_next", ["status", "nextRunAt"]),

  /** Operational pauses. Never consulted for repayment, liquidation, claims or withdrawals. */
  opsFlags: defineTable({
    key: v.string(),
    paused: v.boolean(),
    reason: v.optional(v.string()),
    updatedBy: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  /** Live (Vercel Cron) and shadow (Convex) cranker observations, compared before cutover. */
  crankObservations: defineTable({
    source: v.union(v.literal("live"), v.literal("shadow")),
    at: v.number(),
    slot: v.string(),
    due: v.array(v.string()),
    triggered: v.array(v.string()),
    error: v.optional(v.string()),
  }).index("by_at", ["at"]),

  /** Reference liquidator results (Story 21.3). Operator capital only; no user data. */
  keeperRuns: defineTable({
    at: v.number(),
    offer: v.string(),
    result: v.string(),
    signature: v.optional(v.string()),
    lastValidBlockHeight: v.optional(v.number()),
    payoff: v.optional(v.string()),
  })
    .index("by_at", ["at"])
    .index("by_offer", ["offer"])
    .index("by_result", ["result"])
    .index("by_result_at", ["result", "at"])
    .index("by_signature", ["signature"]),

  keeperCapital: defineTable({
    at: v.number(),
    usdc: v.string(),
    scanned: v.number(),
  }).index("by_at", ["at"]),

  oracleSamples: defineTable({
    at: v.number(),
    publishTime: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index("by_at", ["at"]),

  /** One-use links that connect a Telegram chat to a signed-in wallet (Story 24.3). */
  telegramLinkTokens: defineTable({
    nonce: v.string(),
    wallet: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  }).index("by_nonce", ["nonce"]),

  telegramChats: defineTable({
    wallet: v.string(),
    chatId: v.string(),
    linkedAt: v.number(),
  })
    .index("by_wallet", ["wallet"])
    .index("by_chat", ["chatId"]),

  /**
   * Consented monitoring. Public loans are read from chain by key. For private loans the server
   * stores only the deadlines the wallet chose to share, and sends generic text.
   */
  alertSubscriptions: defineTable({
    wallet: v.string(),
    kind: v.union(v.literal("public-v1"), v.literal("public-v2"), v.literal("private")),
    loan: v.string(),
    risk: v.boolean(),
    deadlines: v.optional(
      v.object({ maturity: v.number(), graceEnd: v.optional(v.number()), pricedFrom: v.optional(v.number()), terminalFrom: v.optional(v.number()) }),
    ),
    state: v.optional(v.any()),
    active: v.boolean(),
    consentedAt: v.number(),
  })
    .index("by_wallet", ["wallet"])
    .index("by_active", ["active"]),

  authFailures: defineTable({
    reason: v.string(),
    at: v.number(),
  }).index("by_at", ["at"]),
});
