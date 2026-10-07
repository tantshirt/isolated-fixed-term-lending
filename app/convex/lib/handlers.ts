import type { Connection } from "@solana/web3.js";

export type JobContext = {
  attempt: number;
  payload: unknown;
  rpc: () => Connection;
  /** Call before awaiting confirmation of any transaction the job sends. */
  recordSignature: (signature: string, lastValidBlockHeight: number) => Promise<void>;
};

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

/**
 * Job kinds. Each later story registers its own (alerts, provider reconciliation, keeper actions).
 * `selftest` exists so the queue can be exercised end to end on any deployment.
 */
export const HANDLERS: Record<string, JobHandler> = {
  selftest: async ({ attempt, payload }) => {
    const { failTimes = 0 } = (payload ?? {}) as { failTimes?: number };
    if (attempt <= failTimes) throw new Error(`selftest failing attempt ${attempt}`);
    return { attempt };
  },
  /** Records a signature that never lands, then crashes: the queue must reconcile, not resend blindly. */
  "selftest-uncertain": async ({ attempt, recordSignature }) => {
    if (attempt === 1) {
      await recordSignature("1".repeat(64), 0);
      throw new Error("crashed after sending");
    }
    return { attempt };
  },
};

/** Thrown by a handler when retrying cannot help (bad payload, rejected by the program). */
export class PermanentError extends Error {}
