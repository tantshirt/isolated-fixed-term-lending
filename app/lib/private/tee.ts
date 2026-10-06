// Browser access to the MagicBlock Devnet TEE (story 9.4).
// Attestation runs before the first private request. The auth token is kept for
// this tab only (sessionStorage, scoped to the wallet and its expiry), so a reload
// resumes without a new signature; closing the tab or disconnecting forgets it.
// Room session keys never leave memory. Private traffic is never routed anywhere
// but the TEE endpoint.
import { Connection, PublicKey } from "@solana/web3.js";
import { getAuthToken, verifyTeeRpcIntegrity } from "@magicblock-labs/ephemeral-rollups-sdk";

export const TEE_RPC = "https://devnet-tee.magicblock.app";
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;
export type TeeSession = { connection: Connection; wallet: string; expiresAt: number; attestedAt: number };

let attestedAt: number | null = null;
const sessions = new Map<string, TeeSession>();

export class PrivateEndpointError extends Error {}

/** Refuses to send private traffic to anything but the attested TEE. */
export function assertPrivateEndpoint(url: string): void {
  const u = new URL(url);
  if (`${u.protocol}//${u.host}` !== TEE_RPC) {
    throw new PrivateEndpointError(`Private requests only go to ${TEE_RPC}, not ${u.host}.`);
  }
}

export async function attestTee(): Promise<number> {
  if (attestedAt) return attestedAt;
  await verifyTeeRpcIntegrity(TEE_RPC);
  attestedAt = Date.now();
  return attestedAt;
}

const tokenKey = (wallet: string) => `zenlo:tee-token:${wallet}`;

function restore(wallet: string): TeeSession | null {
  try {
    const raw = sessionStorage.getItem(tokenKey(wallet));
    if (!raw) return null;
    const { token, expiresAt, attestedAt: at } = JSON.parse(raw) as { token: string; expiresAt: number; attestedAt: number };
    if (!(expiresAt > Date.now() + 60_000)) return sessionStorage.removeItem(tokenKey(wallet)), null;
    const url = `${TEE_RPC}?token=${token}`;
    assertPrivateEndpoint(url);
    const session = { connection: new Connection(url, "confirmed"), wallet, expiresAt, attestedAt: at };
    sessions.set(wallet, session);
    attestedAt ??= at;
    return session;
  } catch {
    return null;
  }
}

export function currentTeeSession(wallet: PublicKey): TeeSession | null {
  const key = wallet.toBase58();
  const s = sessions.get(key) ?? restore(key);
  return s && s.expiresAt > Date.now() + 60_000 ? s : null;
}

export async function openTeeSession(wallet: PublicKey, signMessage: SignMessage): Promise<TeeSession> {
  const existing = currentTeeSession(wallet);
  if (existing) return existing;
  const at = await attestTee();
  const { token, expiresAt } = await getAuthToken(TEE_RPC, wallet, signMessage);
  const url = `${TEE_RPC}?token=${token}`;
  assertPrivateEndpoint(url);
  const session = { connection: new Connection(url, "confirmed"), wallet: wallet.toBase58(), expiresAt, attestedAt: at };
  sessions.set(session.wallet, session);
  try {
    sessionStorage.setItem(tokenKey(session.wallet), JSON.stringify({ token, expiresAt, attestedAt: at }));
  } catch {}
  return session;
}

export function closeTeeSession(wallet: PublicKey): void {
  sessions.delete(wallet.toBase58());
  try {
    sessionStorage.removeItem(tokenKey(wallet.toBase58()));
  } catch {}
}
