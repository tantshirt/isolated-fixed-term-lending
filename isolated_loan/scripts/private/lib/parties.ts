// Test parties for private-protocol scripts: fresh wallets funded from the main
// wallet, with private balances, returned to the main wallet at the end.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import {
  DELEGATION_PROGRAM_ID,
  ESPL_PROGRAM_ID,
  FLAG,
  ata,
  createEataPermission,
  delegate,
  delegateEataPermission,
  deposit,
  eataAmount,
  eataPda,
  initializeEata,
  permissionPda,
  undelegate,
  withdraw,
} from "../../../../app/lib/private/espl";
import { authority as funder, base, sleep, teeConnection, waitFor } from "../../../spikes/lib/custody";

export const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const WSOL = NATIVE_MINT;

export type Party = { kp: Keypair; er: Connection; name: string };

// Test wallets are saved (gitignored) so an interrupted run can be refunded with
// `npx tsx scripts/private/refund-parties.ts`.
const PARTY_DIR = new URL("../../../.local/parties/", import.meta.url);

export function savedParties(): Keypair[] {
  try {
    return readdirSync(PARTY_DIR).map((f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(f, PARTY_DIR), "utf8")))));
  } catch {
    return [];
  }
}

export async function newParty(name: string, lamports: number, usdc: bigint): Promise<Party> {
  const kp = Keypair.generate();
  mkdirSync(PARTY_DIR, { recursive: true });
  writeFileSync(new URL(`${kp.publicKey.toBase58()}.json`, PARTY_DIR), JSON.stringify([...kp.secretKey]));
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports }));
  if (usdc > 0n) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(funder.publicKey, ata(kp.publicKey, USDC), kp.publicKey, USDC),
      createTransferInstruction(ata(funder.publicKey, USDC), ata(kp.publicKey, USDC), funder.publicKey, usdc),
    );
  }
  await sendAndConfirmTransaction(base, tx, [funder]);
  return { kp, er: await teeConnection(kp), name };
}

/** Puts `amount` (may be 0) into a delegated, owner-only private balance. wSOL is wrapped first. */
export async function makePrivate(p: Party, mint: PublicKey, amount: bigint, opts: { permission?: boolean } = {}) {
  // No explicit permission: the owner can still read the balance and outsiders see a masked 0,
  // but an explicit owner-only permission makes the TEE gateway refuse any program but SPL
  // Token and eSPL from touching the account (403), which would block loans.
  const withPermission = opts.permission ?? false;
  const owner = p.kp.publicKey;
  // The ER mirrors the base token account, so it must exist even for a zero balance.
  const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, mint), owner, mint));
  if (mint.equals(WSOL) && amount > 0n) {
    tx.add(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata(owner, WSOL), lamports: Number(amount) }),
      createSyncNativeInstruction(ata(owner, WSOL)),
    );
  }
  tx.add(initializeEata(owner, mint));
  if (withPermission) tx.add(createEataPermission(owner, mint, FLAG.txLogs | FLAG.txBalances | FLAG.txMessage));
  if (amount > 0n) tx.add(deposit(owner, mint, amount));
  if (withPermission) tx.add(delegateEataPermission(owner, mint));
  tx.add(delegate(owner, mint));
  await sendAndConfirmTransaction(base, tx, [p.kp]);
  if (withPermission) await waitFor(`${p.name} private ${mint.toBase58().slice(0, 4)}`, () => privateBalance(p, mint), (v) => v === amount, 90);
  else await sleep(4000);
}

export async function privateBalance(p: Party, mint: PublicKey): Promise<bigint | null> {
  try {
    return BigInt((await p.er.getTokenAccountBalance(ata(p.kp.publicKey, mint))).value.amount);
  } catch {
    return null;
  }
}

/** Undelegates, withdraws, and sends everything back to the main wallet. */
export async function cashOut(p: Party, mints: PublicKey[]) {
  const owner = p.kp.publicKey;
  for (const mint of mints) {
    const eata = eataPda(owner, mint);
    let info = await base.getAccountInfo(eata);
    if (!info) continue;
    if (info.owner.equals(DELEGATION_PROGRAM_ID)) {
      const tx = new Transaction().add(undelegate(owner, mint));
      tx.feePayer = owner;
      tx.recentBlockhash = (await p.er.getLatestBlockhash()).blockhash;
      tx.sign(p.kp);
      await p.er.confirmTransaction(await p.er.sendRawTransaction(tx.serialize(), { skipPreflight: true }), "confirmed");
      info = await waitFor(`${p.name} back on base`, () => base.getAccountInfo(eata), (i) => i.owner.equals(ESPL_PROGRAM_ID), 120);
    }
    const amount = eataAmount(info.data);
    const out = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, mint), owner, mint));
    if (amount > 0n) out.add(withdraw(owner, mint, amount));
    if (mint.equals(WSOL)) out.add(createCloseAccountInstruction(ata(owner, WSOL), owner, owner));
    else {
      const held = BigInt((await base.getTokenAccountBalance(ata(owner, mint)).catch(() => ({ value: { amount: "0" } }))).value.amount) + amount;
      if (held > 0n) {
        out.add(
          createAssociatedTokenAccountIdempotentInstruction(owner, ata(funder.publicKey, mint), funder.publicKey, mint),
          createTransferInstruction(ata(owner, mint), ata(funder.publicKey, mint), owner, held),
        );
      }
    }
    await sendAndConfirmTransaction(base, out, [p.kp]);
  }
  await sleep(500);
  const left = await base.getBalance(owner);
  if (left > 10_000) {
    await sendAndConfirmTransaction(
      base,
      new Transaction().add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: funder.publicKey, lamports: left - 5_000 })),
      [p.kp],
    ).catch(() => undefined);
  }
  if ((await base.getBalance(owner)) <= 10_000) {
    try {
      unlinkSync(new URL(`${owner.toBase58()}.json`, PARTY_DIR));
    } catch {}
  }
}

export { permissionPda };
