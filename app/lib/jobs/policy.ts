/**
 * Durable job rules shared by Convex and tests. A job that sent a transaction never resubmits
 * until that signature is known to have failed or its blockhash has expired.
 */
export const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 30 * 60_000;

/** Exponential backoff with a cap, plus up to 20% jitter supplied by the caller (0..1). */
export function retryDelayMs(attempt: number, jitter = 0): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (1 + 0.2 * Math.min(1, Math.max(0, jitter))));
}

export type SignatureState =
  | { kind: "confirmed" }
  | { kind: "failed"; error: string }
  /** Not found on chain. `blockhashExpired` is true once the block height passed lastValidBlockHeight. */
  | { kind: "unknown"; blockhashExpired: boolean };

export type Reconciliation = "succeeded" | "retry" | "wait";

/**
 * What to do with a job whose last attempt sent `signature` but did not learn the outcome.
 * Waiting is the safe answer whenever the original transaction could still land.
 */
export function reconcile(state: SignatureState): Reconciliation {
  if (state.kind === "confirmed") return "succeeded";
  if (state.kind === "failed") return "retry";
  return state.blockhashExpired ? "retry" : "wait";
}

export type JobStatus = "queued" | "running" | "uncertain" | "succeeded" | "failed";

/** Next status after an attempt that threw before any transaction was sent. */
export function afterError(attempts: number, maxAttempts = MAX_ATTEMPTS): Extract<JobStatus, "queued" | "failed"> {
  return attempts >= maxAttempts ? "failed" : "queued";
}

/** A running job whose lease expired is treated as uncertain if it recorded a signature. */
export function afterLeaseExpired(hasSignature: boolean): Extract<JobStatus, "queued" | "uncertain"> {
  return hasSignature ? "uncertain" : "queued";
}

/** Processed transactions may still confirm even after their blockhash stops accepting new sends. */
export function signatureState(
  status: { err: unknown; confirmationStatus?: string | null } | null,
  finalizedHeight: number,
  lastValidBlockHeight?: number,
): SignatureState {
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
    return status.err ? { kind: "failed", error: JSON.stringify(status.err) } : { kind: "confirmed" };
  }
  return { kind: "unknown", blockhashExpired: status === null && lastValidBlockHeight !== undefined && finalizedHeight > lastValidBlockHeight };
}
