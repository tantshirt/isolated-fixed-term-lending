import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { PYTH_PRICE_UPDATE_ACCOUNT, MAX_PRICE_AGE_SECONDS, NATIVE_WSOL_MINT } from "../../lib/constants";
import { decodePriceUpdateV2 } from "../../lib/server/price-update-codec";
import type { PriceSnapshot } from "../../lib/offer-status";
import { MandateJobRefused, runMandateJob, type MandateJobDeps } from "../../lib/v2/keeper";
import { decodeMandate, executeMandateIx } from "../../lib/v2/mandates";
import { fetchOfferV2 } from "../../lib/v2/offers";

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
  /**
   * Story 26.3: executes one public automation mandate with the keeper key. Private mandates are
   * refused: they run in the rollup crank, never here. Mandates are servicing, so an
   * originations pause never stops them. The queue's dedup key and signature reconciliation
   * apply as for every job.
   */
  "mandate-execute": async ({ payload, rpc, recordSignature }) => {
    try {
      return await runMandateJob(payload, mandateDeps(rpc(), recordSignature));
    } catch (e) {
      if (e instanceof MandateJobRefused) throw new PermanentError(e.message);
      throw e;
    }
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


/** Whether this deployment runs public mandates: the flag and a keeper key. */
export function mandatesEnabled(): boolean {
  return process.env.MANDATES_ENABLED === "1" && !!process.env.KEEPER_SECRET;
}

function mandateDeps(connection: Connection, recordSignature: JobContext["recordSignature"]): MandateJobDeps {
  const keeper = mandatesEnabled() ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEEPER_SECRET!))) : null;
  return {
    enabled: !!keeper,
    loadMandate: async (key) => {
      const info = await connection.getAccountInfo(new PublicKey(key));
      return info ? decodeMandate(new PublicKey(key), info.data as Buffer) : null;
    },
    loadOffer: (key) => fetchOfferV2(connection, new PublicKey(key)),
    // SOL/USD only; another asset's health trigger is decided by simulation against its feed.
    readPrice: async (o): Promise<PriceSnapshot | null> => {
      if (o.wsolMint !== NATIVE_WSOL_MINT.toBase58()) return null;
      const info = await connection.getAccountInfo(PYTH_PRICE_UPDATE_ACCOUNT);
      if (!info) return null;
      const d = decodePriceUpdateV2(info.data as Buffer);
      const publishTime = Number(d.publishTime);
      return { price: d.price, conf: d.conf, exponent: d.exponent, publishTime, fresh: Math.floor(Date.now() / 1000) - publishTime <= MAX_PRICE_AGE_SECONDS - 10 };
    },
    sign: async (m, o, fee) => {
      const ix = await executeMandateIx(keeper!, connection, m, o, fee);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: keeper!.publicKey, blockhash, lastValidBlockHeight }).add(ix);
      tx.sign(keeper!);
      return { tx, lastValidBlockHeight };
    },
    simulate: async (tx) => (await connection.simulateTransaction(tx)).value.err,
    recordSignature,
    send: async (tx, lastValidBlockHeight) => {
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      const res = await connection.confirmTransaction({ signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight }, "confirmed");
      return res.value.err ? "failed-chain" : "confirmed";
    },
    now: () => Math.floor(Date.now() / 1000),
  };
}
