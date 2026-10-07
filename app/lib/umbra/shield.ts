/**
 * Pure helpers for the Umbra wSOL shielding panel (Story 26.6). Nothing here imports the Umbra
 * SDK, so the panel can render, validate and explain without loading it.
 */

export const WSOL_DECIMALS = 9;
export const UMBRA_DEVNET_INDEXER = "https://utxo-indexer.api-devnet.umbraprivacy.com";

export type AmountCheck = { ok: true; lamports: bigint } | { ok: false; reason: string };

/** Parses a typed wSOL amount into lamports without floating point. */
export function parseWsolAmount(input: string, available: bigint | null): AmountCheck {
  const v = input.trim().replace(/,/g, "");
  if (!v) return { ok: false, reason: "Enter an amount." };
  if (!/^\d*\.?\d*$/.test(v) || v === ".") return { ok: false, reason: "Use digits and one decimal point." };
  const [whole = "", frac = ""] = v.split(".");
  if (frac.length > WSOL_DECIMALS) return { ok: false, reason: `wSOL has ${WSOL_DECIMALS} decimal places.` };
  const lamports = BigInt(whole || "0") * 1_000_000_000n + BigInt((frac || "").padEnd(WSOL_DECIMALS, "0") || "0");
  if (lamports <= 0n) return { ok: false, reason: "Enter more than zero." };
  if (available !== null && lamports > available) return { ok: false, reason: "That is more than you have." };
  return { ok: true, lamports };
}

/** WebSocket endpoint for Umbra's transaction forwarder. */
export function subscriptionsUrl(rpcUrl: string, wsUrl?: string): string {
  if (wsUrl) return wsUrl;
  return rpcUrl.replace(/^http(s?):\/\//, (_m, s: string) => `ws${s}://`);
}

/** Plain words for an Umbra or wallet failure. Raw SDK text never reaches the page. */
export function shieldErrorMessage(e: unknown): string {
  const text = (e instanceof Error ? `${e.name} ${e.message}` : String(e ?? "")).toLowerCase();
  if (text.includes("umbra-mxe-unsupported")) return MXE_UNSUPPORTED_WORDS;
  if (/reject|denied|cancel|declined/.test(text)) return "You cancelled in your wallet. Nothing moved.";
  if (/insufficient|not enough|custom program error: 0x1\b/.test(text)) return "There isn't enough wSOL or SOL for this and its fees.";
  if (/signmessage|sign message|solana:signmessage|feature/.test(text)) return "This wallet can't sign the message Umbra needs. Try Phantom, Backpack or Solflare.";
  if (/blockhash|expired|timed? ?out|timeout/.test(text)) return "Devnet was slow and the request expired. Nothing was lost; check your balance and try again.";
  if (/network|fetch|failed to fetch|econn|503|502|429/.test(text)) return "Couldn't reach Devnet or Umbra. Try again in a moment.";
  if (/not registered|non_existent|registration/.test(text)) return "Your Umbra account isn't set up yet. Shield once to set it up.";
  return "Umbra couldn't finish this. Nothing was taken that you can't recover; check your balance and try again.";
}

export type CallbackStatus = "finalized" | "pruned" | "timed-out" | undefined;

/** What to tell the person after a shield or unshield was queued. */
export function callbackWords(op: "shield" | "unshield", status: CallbackStatus): string {
  const done = op === "shield" ? "Shielded." : "Unshielded to your wallet.";
  if (status === "finalized" || status === undefined) return done;
  if (status === "timed-out")
    return "Submitted, but Umbra's confirmation is still pending. Use Recover shielded balance in a minute to see where it landed.";
  return "Umbra dropped the confirmation. Your wSOL is held by Umbra; use Recover shielded balance, then try again.";
}

export type EncryptedBalanceState =
  | { state: "non_existent" }
  | { state: "uninitialized" }
  | { state: "mxe" }
  | { state: "shared"; balance: bigint };

/** The installed SDK withdraws shared balances only; it cannot convert an existing MXE balance. */
export const MXE_UNSUPPORTED_WORDS = "This Umbra balance uses network encryption. ZenLo cannot add to or withdraw it yet. Contact Umbra about converting it to a shared balance.";

export function requireSupportedBalance(balance: EncryptedBalanceState): void {
  if (balance.state === "mxe") throw new Error("umbra-mxe-unsupported");
}

/** Shielded balance in words. Only "shared" balances can be decrypted on this device. */
export function balanceWords(b: EncryptedBalanceState | null): { lamports: bigint | null; note: string } {
  if (!b) return { lamports: null, note: "Hidden. Unlock with one wallet signature to see it." };
  switch (b.state) {
    case "shared":
      return { lamports: b.balance, note: "Decrypted on this device." };
    case "mxe":
      return { lamports: null, note: MXE_UNSUPPORTED_WORDS };
    case "uninitialized":
    case "non_existent":
      return { lamports: 0n, note: "Nothing shielded yet." };
  }
}

/**
 * Field names that would mean an Umbra or viewing secret is being persisted or sent. Used by the
 * key-leak test over Convex, notifications, telemetry and exports.
 */
export const SECRET_FIELD_PATTERN =
  /(viewing_?keys?|master_?seed|master_?viewing_?key|spending_?key|x25519_?private_?key|poseidon_?private_?key|seed_?phrase|mnemonic|umbra_?seed|umbra_?signature)/i;

/** Stricter list for stored schemas: no table may hold any private key at all. */
export const SCHEMA_SECRET_PATTERN = new RegExp(`${SECRET_FIELD_PATTERN.source}|private_?key|secret_?key`, "i");
