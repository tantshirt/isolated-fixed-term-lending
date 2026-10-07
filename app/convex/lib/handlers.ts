import type { Connection } from "@solana/web3.js";

/** Thrown by a handler when retrying cannot help (bad payload, rejected by the program). */
export class PermanentError extends Error {}

export type JobContext = {
  attempt: number;
  payload: unknown;
  rpc: () => Connection;
  canSendAlert: (subscriptionId: string, chatLinkId: string, chatId: string) => Promise<"allowed" | "revoked" | "paused">;
  /** Call before awaiting confirmation of any transaction the job sends. */
  recordSignature: (signature: string, lastValidBlockHeight: number) => Promise<void>;
};

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

/**
 * Job kinds. Each later story registers its own (alerts, provider reconciliation, keeper actions).
 * `selftest` exists so the queue can be exercised end to end on any deployment.
 */
export const HANDLERS: Record<string, JobHandler> = {
  /** Telegram Bot API sendMessage. Text is already generic for private loans. */
  "telegram-send": async ({ payload, canSendAlert }) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new PermanentError("TELEGRAM_BOT_TOKEN is not set on this deployment.");
    const { chatId, text, subscriptionId, chatLinkId } = payload as { chatId: string; text: string; subscriptionId?: string; chatLinkId?: string };
    if (subscriptionId) {
      const permission = chatLinkId ? await canSendAlert(subscriptionId, chatLinkId, chatId) : "revoked";
      if (permission === "revoked") return { skipped: true };
      if (permission === "paused") throw new Error("Telegram delivery is paused.");
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 400 || res.status === 403) throw new PermanentError(`Telegram refused the message (${res.status}).`);
    if (!res.ok) throw new Error(`Telegram returned ${res.status}`);
    return { sent: true };
  },
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

