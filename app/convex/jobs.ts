import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { MAX_ATTEMPTS, afterError, afterLeaseExpired, retryDelayMs } from "../lib/jobs/policy";

const LEASE_MS = 2 * 60_000;
const BATCH = 20;

/** Enqueue once per dedupKey. A second enqueue with the same key returns the existing job. */
export const enqueue = internalMutation({
  args: { kind: v.string(), dedupKey: v.string(), payload: v.any(), runAt: v.optional(v.number()), maxAttempts: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const existing = await ctx.db.query("jobs").withIndex("by_dedup", (q) => q.eq("dedupKey", a.dedupKey)).unique();
    if (existing) return existing._id;
    const now = Date.now();
    return ctx.db.insert("jobs", {
      kind: a.kind,
      dedupKey: a.dedupKey,
      payload: a.payload,
      status: "queued",
      attempts: 0,
      maxAttempts: a.maxAttempts ?? MAX_ATTEMPTS,
      nextRunAt: a.runAt ?? now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Leases due jobs and schedules each one. Runs from the dispatcher cron. */
export const dispatch = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Recover expired leases first: a job that may have sent a transaction becomes uncertain.
    const stale = await ctx.db.query("jobs").withIndex("by_status_next", (q) => q.eq("status", "running")).take(BATCH);
    for (const j of stale) {
      if ((j.leaseUntil ?? 0) > now) continue;
      await ctx.db.patch(j._id, { status: afterLeaseExpired(!!j.signature), leaseUntil: undefined, updatedAt: now, lastError: "lease expired" });
    }
    const due = await ctx.db.query("jobs").withIndex("by_status_next", (q) => q.eq("status", "queued").lte("nextRunAt", now)).take(BATCH);
    for (const j of due) {
      await ctx.db.patch(j._id, { status: "running", attempts: j.attempts + 1, leaseUntil: now + LEASE_MS, updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.jobRunner.run, { id: j._id });
    }
    const uncertain = await ctx.db.query("jobs").withIndex("by_status_next", (q) => q.eq("status", "uncertain").lte("nextRunAt", now)).take(BATCH);
    for (const j of uncertain) {
      await ctx.db.patch(j._id, { nextRunAt: now + 30_000, updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.jobRunner.reconcileOne, { id: j._id });
    }
    return { recovered: stale.length, started: due.length, reconciling: uncertain.length };
  },
});

export const get = internalQuery({ args: { id: v.id("jobs") }, handler: (ctx, { id }) => ctx.db.get(id) });

/** Record a signature before awaiting confirmation, so a crash leaves the job uncertain, not retryable. */
export const recordSignature = internalMutation({
  args: { id: v.id("jobs"), signature: v.string(), lastValidBlockHeight: v.number() },
  handler: async (ctx, { id, signature, lastValidBlockHeight }) => {
    await ctx.db.patch(id, { signature, lastValidBlockHeight, updatedAt: Date.now() });
  },
});

export const succeed = internalMutation({
  args: { id: v.id("jobs"), result: v.optional(v.any()) },
  handler: async (ctx, { id, result }) => {
    await ctx.db.patch(id, { status: "succeeded", result, leaseUntil: undefined, lastError: undefined, updatedAt: Date.now() });
  },
});

/** An attempt failed before or after sending. `retryable` false means the failure is final. */
export const fail = internalMutation({
  args: { id: v.id("jobs"), error: v.string(), retryable: v.boolean(), clearSignature: v.optional(v.boolean()) },
  handler: async (ctx, { id, error, retryable, clearSignature }) => {
    const j = await ctx.db.get(id);
    if (!j) return;
    const now = Date.now();
    const status = retryable ? afterError(j.attempts, j.maxAttempts) : "failed";
    await ctx.db.patch(id, {
      status,
      lastError: error.slice(0, 500),
      leaseUntil: undefined,
      nextRunAt: now + retryDelayMs(j.attempts, Math.random()),
      updatedAt: now,
      ...(clearSignature ? { signature: undefined, lastValidBlockHeight: undefined } : {}),
    });
  },
});

export const markUncertain = internalMutation({
  args: { id: v.id("jobs"), error: v.string() },
  handler: async (ctx, { id, error }) => {
    await ctx.db.patch(id, { status: "uncertain", lastError: error.slice(0, 500), leaseUntil: undefined, nextRunAt: Date.now() + 30_000, updatedAt: Date.now() });
  },
});

export const purgeFinished = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 14 * 86_400_000;
    for (const status of ["succeeded", "failed"] as const) {
      const old = await ctx.db.query("jobs").withIndex("by_status_next", (q) => q.eq("status", status)).take(500);
      for (const j of old) if (j.updatedAt < cutoff) await ctx.db.delete(j._id);
    }
  },
});
