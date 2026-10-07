import { depositAssetOk, KIND_FOR, verifyWebhook, type CashDirection, type RampsEnv } from "./moneygram";

/** What the webhook route may read and do. Injected so its decisions can be tested. */
export type WebhookDeps = {
  /** True the first time this delivery key is seen. */
  claimEvent: (key: string) => Promise<boolean>;
  findRow: (mgiTransactionId: string) => Promise<{ rampsId: string; direction?: CashDirection } | null>;
  reconcile: (rampsId: string) => Promise<unknown>;
  recordFailure: (reason: string) => Promise<unknown>;
};

export type WebhookOutcome = { status: 200 | 401; handled: "reconcile" | "duplicate" | "unknown" | "rejected" | "stale" };

/**
 * MoneyGram status webhook for cash-in and cash-out. Verified exactly as documented, checked
 * against this environment's USDC mint for deposits, deduplicated on (id, status), and matched to
 * a stored row of the same direction. Nothing is stored from the body: reconciliation with
 * GET /status?sync=true decides the status.
 */
export async function handleWebhook(
  input: { signature: string | null; rawBody: string; host: string; webhookKey: string; env: RampsEnv; now: number },
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  const result = verifyWebhook(input);
  if (!result.ok) {
    await deps.recordFailure(`moneygram-${result.reason}`);
    // Stale retries are acknowledged so MoneyGram stops resending them, but never acted on.
    return result.reason === "stale" ? { status: 200, handled: "stale" } : { status: 401, handled: "rejected" };
  }
  const tx = result.transaction;
  if (tx.kind === "deposit") {
    const asset = depositAssetOk(tx, input.env);
    if (!asset.ok) {
      await deps.recordFailure(`moneygram-deposit-${asset.reason}`);
      return { status: 200, handled: "rejected" };
    }
  }
  if (!(await deps.claimEvent(`${tx.id}:${tx.status}`))) return { status: 200, handled: "duplicate" };
  const row = await deps.findRow(tx.id);
  if (!row) return { status: 200, handled: "unknown" };
  if (KIND_FOR[row.direction ?? "out"] !== tx.kind) {
    await deps.recordFailure("moneygram-wrong-kind");
    return { status: 200, handled: "rejected" };
  }
  await deps.reconcile(row.rampsId);
  return { status: 200, handled: "reconcile" };
}
