/**
 * MoneyGram Ramps cash-out (Story 24.4), following the official Ramps developer docs:
 * quickstarts/web-solana, guides/web-solana and reference/transaction-status-webhooks.
 * Pure helpers shared by Convex and tests; no secrets here.
 */
import { base58 } from "@scure/base";
import nacl from "tweetnacl";

export const RAMPS = {
  sandbox: {
    base: "https://playground.xramps.moneygram.com",
    sdk: "https://playground.xramps.moneygram.com/sdk/index.global.js",
    /** Ed25519 webhook key, published as a Stellar-style G... strkey. */
    webhookKey: "GCUZ6YLL5RQBTYLTTQLPCM73C5XAIUGK2TIMWQH7HPSGWVS2KJ2F3CHS",
    requiredNetwork: "testnet" as const,
    usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  },
  production: {
    base: "https://xramps.moneygram.com",
    sdk: "https://xramps.moneygram.com/sdk/index.global.js",
    webhookKey: "GD5NUMEX7LYHXGXCAD4PGW7JDMOUY2DKRGY5XZHJS5IONVHDKCJYGVCL",
    requiredNetwork: "mainnet" as const,
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
} as const;
export type RampsEnv = keyof typeof RAMPS;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32-decode a G... strkey and drop the version byte and two checksum bytes. */
export function strkeyToEd25519(strkey: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of strkey.replace(/=+$/, "")) {
    const i = BASE32.indexOf(c);
    if (i === -1) throw new Error("invalid strkey");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const raw = Uint8Array.from(out).subarray(1, out.length - 2);
  if (raw.length !== 32) throw new Error("invalid strkey");
  return raw;
}

/** `Signature: t=1787932754,s=<base64>`: split on commas, then each part on its first "=". */
export function parseSignatureHeader(header: string | null): { t: string; s: string } | null {
  if (!header) return null;
  const parts: Record<string, string> = {};
  for (const piece of header.split(",")) {
    const i = piece.indexOf("=");
    if (i > 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
  }
  return parts.t && parts.s ? { t: parts.t, s: parts.s } : null;
}

/** Retries replay the original timestamp for up to an hour, so the window is 65 minutes. */
export const WEBHOOK_MAX_AGE_MS = 65 * 60_000;
export const WEBHOOK_MAX_SKEW_MS = 5 * 60_000;

export type WebhookTransaction = {
  id: string;
  network?: string;
  transaction_id?: string;
  external_transaction_id?: string;
  kind: "deposit" | "withdrawal";
  status: string;
  amount_in?: string;
  amount_in_asset?: string;
  amount_out?: string;
  amount_out_asset?: string;
};

export type WebhookResult = { ok: true; transaction: WebhookTransaction } | { ok: false; reason: "no-signature" | "bad-body" | "bad-signature" | "stale" | "bad-message" };

/**
 * Verifies a status webhook exactly as documented: Ed25519 over `{t}.{host}.{message}`, where
 * `message` is the raw string inside the JSON body, never re-serialized. Freshness is checked
 * after the signature. The transaction is parsed only once everything passes.
 */
export function verifyWebhook(input: { signature: string | null; rawBody: string; host: string; webhookKey: string; now: number }): WebhookResult {
  const sig = parseSignatureHeader(input.signature);
  if (!sig) return { ok: false, reason: "no-signature" };
  let message: unknown;
  try {
    message = (JSON.parse(input.rawBody) as { message?: unknown }).message;
  } catch {
    return { ok: false, reason: "bad-body" };
  }
  if (typeof message !== "string") return { ok: false, reason: "bad-body" };
  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(Buffer.from(sig.s, "base64"));
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  const plaintext = new TextEncoder().encode(`${sig.t}.${input.host}.${message}`);
  if (signature.length !== 64 || !nacl.sign.detached.verify(plaintext, signature, strkeyToEd25519(input.webhookKey))) return { ok: false, reason: "bad-signature" };
  const age = input.now - Number(sig.t) * 1000;
  if (!Number.isFinite(age) || age < -WEBHOOK_MAX_SKEW_MS || age > WEBHOOK_MAX_AGE_MS) return { ok: false, reason: "stale" };
  try {
    const tx = (JSON.parse(message) as { transaction?: WebhookTransaction }).transaction;
    if (!tx || typeof tx.id !== "string" || typeof tx.status !== "string") return { ok: false, reason: "bad-message" };
    return { ok: true, transaction: tx };
  } catch {
    return { ok: false, reason: "bad-message" };
  }
}

/** The widget's `onSignTransaction` payload (guides/web-solana, Step 3). */
export type SignPayload = {
  chain: string;
  to: string;
  amount: string;
  asset: string;
  requiredNetwork?: "mainnet" | "testnet";
  tokenAddress?: string;
  tokenDecimals?: number;
  memo?: string;
};

export function toBaseUnits(amount: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(amount)) throw new Error("Amount must be a decimal string");
  const [whole, fraction = ""] = amount.split(".");
  if (!/^\d+$/.test(whole) || (fraction && !/^\d+$/.test(fraction))) throw new Error("Amount must be a decimal string");
  if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places`);
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

export type ReviewedTransfer = { to: string; mint: string; atoms: bigint; decimals: number; network: "mainnet" | "testnet" };

/**
 * Checks what MoneyGram asks the wallet to sign against what this deployment allows: chain,
 * asset, network, the canonical USDC mint, 6 decimals, a valid recipient, a positive amount the
 * payer holds. Anything else is refused before the wallet is ever asked.
 */
export function reviewSignPayload(tx: SignPayload, env: RampsEnv, payerUsdcAtoms: bigint): { ok: true; transfer: ReviewedTransfer } | { ok: false; reason: string } {
  const e = RAMPS[env];
  if (tx.chain !== "solana" || tx.asset !== "USDC") return { ok: false, reason: "MoneyGram asked for a transfer that is not USDC on Solana." };
  if (tx.requiredNetwork !== e.requiredNetwork) return { ok: false, reason: `MoneyGram asked for ${tx.requiredNetwork ?? "an unnamed network"}; this is ${e.requiredNetwork === "testnet" ? "Devnet" : "mainnet"}.` };
  if (tx.tokenAddress !== e.usdcMint) return { ok: false, reason: "MoneyGram asked for a different USDC mint than this network's." };
  if (tx.tokenDecimals !== 6) return { ok: false, reason: "MoneyGram asked for an unexpected number of decimals." };
  let to: Uint8Array;
  try {
    to = base58.decode(tx.to);
  } catch {
    return { ok: false, reason: "MoneyGram's deposit address is not a Solana address." };
  }
  if (to.length !== 32) return { ok: false, reason: "MoneyGram's deposit address is not a Solana address." };
  let atoms: bigint;
  try {
    atoms = toBaseUnits(tx.amount, 6);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (atoms <= 0n) return { ok: false, reason: "The amount must be above zero." };
  if (atoms > payerUsdcAtoms) return { ok: false, reason: "This wallet does not hold enough USDC for that cash-out." };
  return { ok: true, transfer: { to: tx.to, mint: e.usdcMint, atoms, decimals: 6, network: e.requiredNetwork } };
}

/** Ramps API cash-out statuses (reference/transaction-status-webhooks, Cash-out status phases). */
export const CASH_OUT_WORDS: Record<string, string> = {
  created: "Started",
  pending_commit: "Waiting for you to confirm in MoneyGram",
  awaiting_funds: "Waiting for your USDC to arrive",
  funds_received: "MoneyGram received your USDC. Cash is not ready yet.",
  completed: "Ready for pickup",
  paid_out: "Cash collected",
  failed: "Failed",
  quote_expired: "The quote expired",
  refund_requested: "Refund requested",
  refund_mgi_pending: "Refund in progress",
  refund_mgi_success: "Refund in progress",
  refunded: "Refunded",
  refund_failed: "Refund failed",
};

/** Sandbox references never imply that real cash is ready or was collected. */
export const SANDBOX_CASH_OUT_WORDS: Record<string, string> = {
  ...CASH_OUT_WORDS,
  completed: "Sandbox: test transfer complete, no cash to collect",
  paid_out: "Sandbox: marked paid out (test only)",
};

/** Polling stops here; `funds_received` is deliberately not terminal. */
export const CASH_OUT_TERMINAL = new Set(["paid_out", "failed", "quote_expired", "refunded", "refund_failed"]);
