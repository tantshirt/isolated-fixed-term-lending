// Execution receipts for the private protocol (story 9.4).
//
// A private action can be executed inside the TEE long before anything settles
// on Solana, and a commit can be queued without having landed. The receipt keeps
// those as separate facts and survives reloads until it is reconciled. Nothing
// here ever re-sends a transaction: recovery reuses the recorded signatures.
import type { Connection } from "@solana/web3.js";
import { readSubmissionStorage, writeSubmissionStorage } from "../transaction-lifecycle";

export type Environment = "er" | "base";
export type ReceiptStage =
  /** Signed and sent; outcome not yet known. Never resend. */
  | "submitted"
  /** Confirmed inside the TEE. Not settled on Solana. */
  | "executed"
  /** A commit or undelegation was scheduled; waiting for the base layer. */
  | "settling"
  /** Confirmed on Solana. */
  | "settled"
  /** Confirmed with an error, or rejected before sending. */
  | "failed";

export type ExecutionReceipt = {
  id: string;
  intent: string;
  environment: Environment;
  /** Room or loan revision the action was bound to, when there is one. */
  revision?: number;
  erSignature?: string;
  /** Commit or action id reported by the ER, when the action settles to Solana. */
  commitId?: string;
  baseSignature?: string;
  stage: ReceiptStage;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

/** What an operation deliberately reveals, shown before the user signs. */
export type PrivacyDisclosure = {
  publicOnSolana: string[];
  visibleToMembers: string[];
  neverRevealed: string[];
};

const KEY = (wallet: string) => `lendspan:private:receipts:${wallet}`;
const MAX_RECEIPTS = 50;

function readAll(wallet: string): ExecutionReceipt[] {
  const raw = readSubmissionStorage(KEY(wallet));
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("Saved private receipts are unreadable; nothing was sent.");
  return raw as ExecutionReceipt[];
}

export function listReceipts(wallet: string): ExecutionReceipt[] {
  return readAll(wallet).sort((a, b) => b.createdAt - a.createdAt);
}

export function saveReceipt(wallet: string, receipt: ExecutionReceipt): ExecutionReceipt {
  const all = readAll(wallet).filter((r) => r.id !== receipt.id);
  // Unresolved receipts are never dropped to make room.
  const open = all.filter((r) => r.stage === "submitted" || r.stage === "settling");
  const closed = all.filter((r) => r.stage !== "submitted" && r.stage !== "settling");
  const kept = [receipt, ...open, ...closed].slice(0, Math.max(MAX_RECEIPTS, open.length + 1));
  writeSubmissionStorage(KEY(wallet), kept);
  return receipt;
}

export function newReceipt(intent: string, environment: Environment, revision?: number): ExecutionReceipt {
  const now = Date.now();
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    intent,
    environment,
    revision,
    stage: "submitted",
    createdAt: now,
    updatedAt: now,
  };
}

export function advance(r: ExecutionReceipt, patch: Partial<ExecutionReceipt>): ExecutionReceipt {
  return { ...r, ...patch, updatedAt: Date.now() };
}

type StatusSource = Pick<Connection, "getSignatureStatuses">;

async function statusOf(c: StatusSource, signature: string) {
  const {
    value: [s],
  } = await c.getSignatureStatuses([signature], { searchTransactionHistory: true });
  if (!s) return "unknown" as const;
  if (s.err) return "failed" as const;
  return s.confirmationStatus === "processed" ? ("unknown" as const) : ("confirmed" as const);
}

/**
 * Moves a receipt forward using only recorded signatures. `er` must be an
 * authenticated TEE connection; `base` is Solana Devnet.
 */
export async function reconcile(r: ExecutionReceipt, er: StatusSource, base: StatusSource): Promise<ExecutionReceipt> {
  if (r.stage === "settled" || r.stage === "failed") return r;
  if (r.environment === "base" && r.baseSignature) {
    const s = await statusOf(base, r.baseSignature);
    if (s === "confirmed") return advance(r, { stage: "settled" });
    if (s === "failed") return advance(r, { stage: "failed", error: "Confirmed on Solana with an error." });
    return r;
  }
  if (r.stage === "submitted" && r.erSignature) {
    const s = await statusOf(er, r.erSignature);
    if (s === "failed") return advance(r, { stage: "failed", error: "Confirmed inside the TEE with an error." });
    if (s === "confirmed") r = advance(r, { stage: r.commitId ? "settling" : "executed" });
  }
  if (r.stage === "settling" && r.baseSignature) {
    const s = await statusOf(base, r.baseSignature);
    if (s === "confirmed") return advance(r, { stage: "settled" });
  }
  return r;
}

export const STAGE_LABEL: Record<ReceiptStage, string> = {
  submitted: "Sent, waiting for confirmation",
  executed: "Done inside the private rollup",
  settling: "Settling on Solana",
  settled: "Settled on Solana",
  failed: "Did not go through",
};
