// Ephemeral SPL Token instructions for a wallet's own private balance (story 9.3).
// Account order follows the deployed program's processors
// (github.com/magicblock-labs/ephemeral-spl-token, e-token/src/processor),
// matching programs/private_loan/src/espl.rs. SDK 0.17.3 orders withdraw wrongly.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export const ESPL_PROGRAM_ID = new PublicKey("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
export const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const PERMISSION_PROGRAM_ID = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
export const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

/** Member flag bits from the permission program. */
export const FLAG = { authority: 1, txLogs: 2, txBalances: 4, txMessage: 8, accountSignatures: 16 } as const;

const enc = new TextEncoder();
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const data = (...parts: (number | Uint8Array)[]) =>
  Buffer.concat(parts.map((p) => (typeof p === "number" ? Buffer.from([p]) : Buffer.from(p))));

export const eataPda = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBytes(), mint.toBytes()], ESPL_PROGRAM_ID)[0];
export const globalVaultPda = (mint: PublicKey) => PublicKey.findProgramAddressSync([mint.toBytes()], ESPL_PROGRAM_ID)[0];
export const ata = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
export const permissionPda = (account: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("permission:"), account.toBytes()], PERMISSION_PROGRAM_ID)[0];
const bufferPda = (account: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("buffer"), account.toBytes()], owner)[0];
const recordPda = (account: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("delegation"), account.toBytes()], DELEGATION_PROGRAM_ID)[0];
const metadataPda = (account: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("delegation-metadata"), account.toBytes()], DELEGATION_PROGRAM_ID)[0];

const ix = (keys: [PublicKey, boolean, boolean][], payload: Buffer) =>
  new TransactionInstruction({
    programId: ESPL_PROGRAM_ID,
    keys: keys.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })),
    data: payload,
  });

export function initializeEata(owner: PublicKey, mint: PublicKey, payer = owner) {
  return ix(
    [
      [eataPda(owner, mint), false, true],
      [payer, true, true],
      [owner, false, false],
      [mint, false, false],
      [SystemProgram.programId, false, false],
    ],
    data(0),
  );
}

export function deposit(owner: PublicKey, mint: PublicKey, amount: bigint) {
  const vault = globalVaultPda(mint);
  return ix(
    [
      [eataPda(owner, mint), false, true],
      [vault, false, false],
      [mint, false, false],
      [ata(owner, mint), false, true],
      [ata(vault, mint), false, true],
      [owner, true, false],
      [TOKEN_PROGRAM_ID, false, false],
    ],
    data(2, u64(amount)),
  );
}

export function withdraw(owner: PublicKey, mint: PublicKey, amount: bigint) {
  const vault = globalVaultPda(mint);
  return ix(
    [
      [owner, true, false],
      [eataPda(owner, mint), false, true],
      [vault, false, false],
      [mint, false, false],
      [ata(vault, mint), false, true],
      [ata(owner, mint), false, true],
      [TOKEN_PROGRAM_ID, false, false],
    ],
    data(3, u64(amount)),
  );
}

export function delegate(owner: PublicKey, mint: PublicKey, validator = TEE_VALIDATOR) {
  const eata = eataPda(owner, mint);
  return ix(
    [
      [owner, true, true],
      [eata, false, true],
      [ESPL_PROGRAM_ID, false, false],
      [bufferPda(eata, ESPL_PROGRAM_ID), false, true],
      [recordPda(eata), false, true],
      [metadataPda(eata), false, true],
      [DELEGATION_PROGRAM_ID, false, false],
      [SystemProgram.programId, false, false],
    ],
    data(4, validator.toBytes()),
  );
}

/** Runs inside the ER. Commits the balance and returns the eATA to Solana. */
export function undelegate(owner: PublicKey, mint: PublicKey) {
  return ix(
    [
      [owner, true, false],
      [ata(owner, mint), false, true],
      [eataPda(owner, mint), false, false],
      [MAGIC_CONTEXT_ID, false, true],
      [MAGIC_PROGRAM_ID, false, false],
    ],
    data(5),
  );
}

/** Makes the balance private to its owner before delegation. */
export function createEataPermission(owner: PublicKey, mint: PublicKey, flags: number) {
  const eata = eataPda(owner, mint);
  return ix(
    [
      [eata, false, true],
      [permissionPda(eata), false, true],
      [owner, true, true],
      [SystemProgram.programId, false, false],
      [PERMISSION_PROGRAM_ID, false, false],
    ],
    data(6, flags),
  );
}

export function delegateEataPermission(owner: PublicKey, mint: PublicKey, validator = TEE_VALIDATOR) {
  const eata = eataPda(owner, mint);
  const permission = permissionPda(eata);
  return ix(
    [
      [owner, true, true],
      [eata, false, true],
      [PERMISSION_PROGRAM_ID, false, false],
      [permission, false, true],
      [SystemProgram.programId, false, false],
      [bufferPda(permission, PERMISSION_PROGRAM_ID), false, true],
      [recordPda(permission), false, true],
      [metadataPda(permission), false, true],
      [DELEGATION_PROGRAM_ID, false, false],
      [validator, false, false],
    ],
    data(7),
  );
}

/** eATA layout: owner 32, mint 32, amount u64 at 64. */
export function eataAmount(raw: Uint8Array): bigint {
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(64, true);
}
