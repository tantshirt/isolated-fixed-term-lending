// Shared helpers for the custody gate and recovery scripts.
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { EPHEMERAL_SPL_TOKEN_PROGRAM_ID, getAuthToken, verifyTeeRpcIntegrity } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export const BASE_RPC = "https://api.devnet.solana.com";
export const TEE_RPC = "https://devnet-tee.magicblock.app";
export const ESPL = EPHEMERAL_SPL_TOKEN_PROGRAM_ID;
export const CUSTODY_SEED = Buffer.from("custody");

export const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))),
);
export const base = new Connection(BASE_RPC, "confirmed");
const idl = JSON.parse(readFileSync(new URL("../../target/idl/private_loan.json", import.meta.url), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const program: any = new Program(idl, new AnchorProvider(base, new Wallet(authority), { commitment: "confirmed" }));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const custodyPda = (id: Buffer) => PublicKey.findProgramAddressSync([CUSTODY_SEED, id], program.programId)[0];
export const eataPda = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), mint.toBuffer()], ESPL)[0];
export const vaultPda = (mint: PublicKey) => PublicKey.findProgramAddressSync([mint.toBuffer()], ESPL)[0];
export const ata = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);

/** eATA layout: owner 32, mint 32, amount u64 at 64. */
export async function eataState(c: Connection, eata: PublicKey) {
  const i = await c.getAccountInfo(eata);
  return i ? { owner: i.owner, amount: i.data.readBigUInt64LE(64) } : null;
}

export async function teeConnection(kp: Keypair): Promise<Connection> {
  await verifyTeeRpcIntegrity(TEE_RPC);
  const { token } = await getAuthToken(TEE_RPC, kp.publicKey, async (m) => nacl.sign.detached(m, kp.secretKey));
  return new Connection(`${TEE_RPC}?token=${token}`, "confirmed");
}

export async function sendEr(er: Connection, ix: TransactionInstruction): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  tx.sign(authority);
  const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await er.confirmTransaction(sig, "confirmed");
  if (res.value.err) throw new Error(`ER tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}

export async function waitFor<T>(label: string, f: () => Promise<T | null>, ok: (v: T) => boolean, seconds = 90): Promise<T> {
  for (let i = 0; i < seconds; i++) {
    const v = await f();
    if (v !== null && ok(v)) return v;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export const undelegateIx = (custody: PublicKey, mint: PublicKey) =>
  program.methods
    .undelegateCustody()
    .accountsPartial({
      authority: authority.publicKey,
      custody,
      custodyAta: ata(custody, mint),
      eata: eataPda(custody, mint),
      esplProgram: ESPL,
    })
    .instruction();

export const withdrawIx = (custody: PublicKey, mint: PublicKey, amount: bigint) =>
  program.methods
    .withdrawCustody(new BN(amount.toString()))
    .accountsPartial({
      authority: authority.publicKey,
      custody,
      mint,
      authorityAta: ata(authority.publicKey, mint),
      custodyAta: ata(custody, mint),
      eata: eataPda(custody, mint),
      vault: vaultPda(mint),
      vaultAta: ata(vaultPda(mint), mint),
      esplProgram: ESPL,
    })
    .instruction();
