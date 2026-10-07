/**
 * Solana Attestation Service credentials for the credit pilot (Story 26.7). Client and server safe.
 *
 * Layout read from solana-foundation/solana-attestation-service (program/src/state/attestation.rs):
 *
 *   [discriminator u8 = 2][nonce 32][credential 32][schema 32][data: u32 LE length + bytes]
 *   [signer 32][expiry i64 LE][token_account 32]
 *
 * PDA seeds are ["attestation", credential, schema, nonce]; ZenLo uses the borrower's wallet as the
 * nonce, so the address itself names the subject. An expiry of 0 never expires. Revocation closes
 * the account, so a revoked credential simply does not exist.
 *
 * ZenLo's schema data is exactly 9 bytes: [tier u8 (1..3)][expiry i64 LE]. Nothing else, and never
 * an income figure. The data expiry is required; a non-zero account expiry can only shorten it.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import type { CreditTier } from "./bands";

export const SAS_PROGRAM_ID = new PublicKey("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
export const ATTESTATION_DISCRIMINATOR = 2;
export const ATTESTATION_SEED = Buffer.from("attestation");
export const CREDIT_DATA_LEN = 9;

/** Public ids of the ZenLo credit credential and schema, when the deployment has them. */
export const CREDIT_CREDENTIAL = process.env.NEXT_PUBLIC_SAS_CREDENTIAL ?? "";
export const CREDIT_SCHEMA = process.env.NEXT_PUBLIC_SAS_SCHEMA ?? "";
/** The public issuer key (Config.authorities.credential_issuer), for display and checks. */
export const CREDIT_ISSUER = process.env.NEXT_PUBLIC_CREDIT_ISSUER ?? "";

export type Attestation = {
  nonce: string;
  credential: string;
  schema: string;
  data: Buffer;
  signer: string;
  expiry: number;
  tokenAccount: string;
};

export function attestationPda(credential: PublicKey, schema: PublicKey, subject: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([ATTESTATION_SEED, credential.toBuffer(), schema.toBuffer(), subject.toBuffer()], SAS_PROGRAM_ID)[0];
}

export function encodeCreditData(tier: CreditTier, expiry: number): Buffer {
  const b = Buffer.alloc(CREDIT_DATA_LEN);
  b.writeUInt8(tier, 0);
  b.writeBigInt64LE(BigInt(expiry), 1);
  return b;
}

export function decodeCreditData(data: Buffer): { tier: number; expiry: number } | null {
  if (data.length !== CREDIT_DATA_LEN) return null;
  return { tier: data.readUInt8(0), expiry: Number(data.readBigInt64LE(1)) };
}

/** Parses SAS attestation bytes; null for anything that is not a well-formed attestation. */
export function parseAttestation(raw: Uint8Array): Attestation | null {
  const b = Buffer.from(raw);
  if (b.length < 1 + 96 + 4 || b[0] !== ATTESTATION_DISCRIMINATOR) return null;
  const key = (o: number) => new PublicKey(b.subarray(o, o + 32)).toBase58();
  const len = b.readUInt32LE(97);
  const after = 101 + len;
  if (b.length < after + 32 + 8 + 32) return null;
  return {
    nonce: key(1),
    credential: key(33),
    schema: key(65),
    data: Buffer.from(b.subarray(101, after)),
    signer: key(after),
    expiry: Number(b.readBigInt64LE(after + 32)),
    tokenAccount: key(after + 40),
  };
}

/** Builds attestation bytes (fixtures and tests). */
export function encodeAttestation(a: Omit<Attestation, "data"> & { data: Buffer }): Buffer {
  const k = (s: string) => new PublicKey(s).toBuffer();
  const len = Buffer.alloc(4);
  len.writeUInt32LE(a.data.length);
  const exp = Buffer.alloc(8);
  exp.writeBigInt64LE(BigInt(a.expiry));
  return Buffer.concat([Buffer.from([ATTESTATION_DISCRIMINATOR]), k(a.nonce), k(a.credential), k(a.schema), len, a.data, k(a.signer), exp, k(a.tokenAccount)]);
}

export type CreditStatus =
  | { state: "none"; reason: string }
  | { state: "invalid"; reason: string }
  | { state: "expired"; tier: number; expiry: number }
  | { state: "valid"; tier: CreditTier; expiry: number };

export type CreditExpect = { credential: string; schema: string; issuer: string };

/**
 * The same decision the program makes at origination, for display: owner, address, credential,
 * schema, issuer, subject, tier range and expiry. Any failure means the standard caps apply.
 */
export function creditStatus(owner: string | null, address: string, raw: Uint8Array | null, subject: string, expect: CreditExpect, now: number): CreditStatus {
  if (!owner || !raw) return { state: "none", reason: "No credential on chain for this wallet." };
  if (owner !== SAS_PROGRAM_ID.toBase58()) return { state: "invalid", reason: "This account is not owned by the Solana Attestation Service." };
  const a = parseAttestation(raw);
  if (!a) return { state: "invalid", reason: "This account is not an attestation." };
  if (a.credential !== expect.credential || a.schema !== expect.schema) return { state: "invalid", reason: "This attestation is for another credential or schema." };
  if (a.signer !== expect.issuer) return { state: "invalid", reason: "This attestation was not signed by ZenLo's credential issuer." };
  if (a.nonce !== subject) return { state: "invalid", reason: "This attestation is for another wallet." };
  try {
    const pda = attestationPda(new PublicKey(a.credential), new PublicKey(a.schema), new PublicKey(subject)).toBase58();
    if (pda !== address) return { state: "invalid", reason: "This attestation is not at its expected address." };
  } catch {
    return { state: "invalid", reason: "This attestation is not at its expected address." };
  }
  const d = decodeCreditData(a.data);
  if (!d || d.tier < 1 || d.tier > 3) return { state: "invalid", reason: "This attestation does not carry a credit tier." };
  const expiry = effectiveExpiry(d.expiry, a.expiry);
  if (expiry === 0 || now >= expiry) return { state: "expired", tier: d.tier, expiry };
  return { state: "valid", tier: d.tier as CreditTier, expiry };
}

/**
 * As the program reads it: the data expiry is required (0 or less is never valid), and a non-zero
 * SAS account expiry can only bring it earlier. Returns 0 when the credential has no valid expiry.
 */
export function effectiveExpiry(dataExpiry: number, accountExpiry: number): number {
  if (dataExpiry <= 0) return 0;
  return accountExpiry > 0 ? Math.min(dataExpiry, accountExpiry) : dataExpiry;
}

export async function readCreditStatus(connection: Connection, subject: PublicKey, expect: CreditExpect, now: number): Promise<CreditStatus> {
  if (!expect.credential || !expect.schema || !expect.issuer) return { state: "none", reason: "This deployment has no credit credential configured." };
  const address = attestationPda(new PublicKey(expect.credential), new PublicKey(expect.schema), subject);
  const info = await connection.getAccountInfo(address, "confirmed");
  return creditStatus(info ? info.owner.toBase58() : null, address.toBase58(), info ? info.data : null, subject.toBase58(), expect, now);
}

/**
 * The exact bytes the issuer signs when it approves an attestation request. Line-based UTF-8, fixed
 * field order, no income:
 *
 *   zenlo-credit-v1
 *   subject:<base58>
 *   credential:<base58>
 *   schema:<base58>
 *   attestation:<base58>
 *   tier:<1|2|3>
 *   expiry:<unix seconds>
 *   data:<hex of the 9-byte schema data>
 */
export function issuanceMessage(r: { subject: string; credential: string; schema: string; attestation: string; tier: CreditTier; expiry: number }): Uint8Array {
  const data = encodeCreditData(r.tier, r.expiry).toString("hex");
  return new TextEncoder().encode(
    ["zenlo-credit-v1", `subject:${r.subject}`, `credential:${r.credential}`, `schema:${r.schema}`, `attestation:${r.attestation}`, `tier:${r.tier}`, `expiry:${r.expiry}`, `data:${data}`].join("\n"),
  );
}
