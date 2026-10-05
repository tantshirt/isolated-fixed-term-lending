// Browser access to the MagicBlock Devnet TEE (story 9.4).
// Attestation runs before the first private request; the auth token lives only
// in memory, so a reload asks the wallet to sign in again. Private traffic is
// never routed anywhere but the TEE endpoint.
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

export function currentTeeSession(wallet: PublicKey): TeeSession | null {
  const s = sessions.get(wallet.toBase58());
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
  return session;
}

export function closeTeeSession(wallet: PublicKey): void {
  sessions.delete(wallet.toBase58());
}
