"use node";

import { v } from "convex/values";
import { Connection } from "@solana/web3.js";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { reconcile, signatureState } from "../lib/jobs/policy";
import { HANDLERS, PermanentError, type JobContext } from "./lib/handlers";

function rpc(): Connection {
  return new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
}

export const run = internalAction({
  args: { id: v.id("jobs") },
  handler: async (ctx, { id }): Promise<void> => {
    const job: Doc<"jobs"> | null = await ctx.runQuery(internal.jobs.get, { id });
    if (!job || job.status !== "running") return;
    const handler = HANDLERS[job.kind];
    if (!handler) {
      await ctx.runMutation(internal.jobs.fail, { id, error: `no handler for ${job.kind}`, retryable: false });
      return;
    }
    const jc: JobContext = {
      attempt: job.attempts,
      payload: job.payload,
      rpc,
      recordSignature: async (signature, lastValidBlockHeight) => {
        await ctx.runMutation(internal.jobs.recordSignature, { id, signature, lastValidBlockHeight });
      },
    };
    try {
      const result = await handler(jc);
      await ctx.runMutation(internal.jobs.succeed, { id, result });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const latest: Doc<"jobs"> | null = await ctx.runQuery(internal.jobs.get, { id });
      // If a signature was recorded, the transaction may still land: reconcile instead of retrying.
      if (latest?.signature) await ctx.runMutation(internal.jobs.markUncertain, { id, error: message });
      else await ctx.runMutation(internal.jobs.fail, { id, error: message, retryable: !(e instanceof PermanentError) });
    }
  },
});

/** Looks up an uncertain job's signature and decides: done, safe to retry, or keep waiting. */
export const reconcileOne = internalAction({
  args: { id: v.id("jobs") },
  handler: async (ctx, { id }): Promise<void> => {
    const job: Doc<"jobs"> | null = await ctx.runQuery(internal.jobs.get, { id });
    if (!job || job.status !== "uncertain" || !job.signature) return;
    const conn = rpc();
    const [{ value: [status] }, height] = await Promise.all([
      conn.getSignatureStatuses([job.signature], { searchTransactionHistory: true }),
      conn.getBlockHeight("finalized"),
    ]);
    const state = signatureState(status, height, job.lastValidBlockHeight);
    const decision = reconcile(state);
    if (decision === "succeeded") await ctx.runMutation(internal.jobs.succeed, { id, result: { reconciled: job.signature } });
    else if (decision === "retry") await ctx.runMutation(internal.jobs.fail, { id, error: state.kind === "failed" ? state.error : "blockhash expired unconfirmed", retryable: true, clearSignature: true });
  },
});

