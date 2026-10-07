import { base58 as bs58 } from "@scure/base";
import nacl from "tweetnacl";

/**
 * Wallet sign-in challenge. The server rebuilds this message from its own stored challenge,
 * so a client can never get a signature over text it chose accepted.
 */
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const JWT_TTL_S = 15 * 60;
export const SESSION_MAX_MS = 12 * 60 * 60_000;
export const AUDIENCE = "zenlo";

export type Challenge = {
  domain: string;
  wallet: string;
  nonce: string;
  network: string;
  issuedAt: number;
  expiresAt: number;
};

export function challengeMessage(c: Challenge): string {
  return [
    `${c.domain} wants you to sign in with your Solana account:`,
    c.wallet,
    "",
    "Sign in to ZenLo. This proves you own this wallet. It does not move funds or approve a transaction.",
    "",
    `URI: https://${c.domain}`,
    `Network: ${c.network}`,
    `Nonce: ${c.nonce}`,
    `Issued At: ${new Date(c.issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(c.expiresAt).toISOString()}`,
  ].join("\n");
}

export function newNonce(): string {
  return bs58.encode(nacl.randomBytes(24));
}

/** A base58 Solana address that decodes to 32 bytes. */
export function isWalletAddress(value: string): boolean {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/**
 * Domains are exact hosts, or one leading `*` label pattern for preview hosts
 * (`zenlo-*-team.vercel.app`). The `*` never matches a dot.
 */
export function domainAllowed(domain: string, allowed: string[]): boolean {
  const host = domain.toLowerCase();
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) return false;
  return allowed.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    if (!p) return false;
    if (!p.includes("*")) return p === host;
    const re = new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9-]*") + "$");
    return re.test(host);
  });
}

export type VerifyFailure = "expired" | "used" | "wrong-wallet" | "wrong-domain" | "bad-signature";

/** Checks one stored challenge against a submitted signature. Pure, so both Convex and tests use it. */
export function verifyChallenge(
  c: Challenge & { usedAt?: number },
  submitted: { wallet: string; domain: string; signature: string },
  now: number,
): VerifyFailure | null {
  if (c.usedAt !== undefined) return "used";
  if (now >= c.expiresAt) return "expired";
  if (submitted.wallet !== c.wallet) return "wrong-wallet";
  if (submitted.domain.toLowerCase() !== c.domain) return "wrong-domain";
  let sig: Uint8Array;
  try {
    sig = bs58.decode(submitted.signature);
  } catch {
    return "bad-signature";
  }
  if (sig.length !== 64) return "bad-signature";
  const ok = nacl.sign.detached.verify(new TextEncoder().encode(challengeMessage(c)), sig, bs58.decode(c.wallet));
  return ok ? null : "bad-signature";
}
