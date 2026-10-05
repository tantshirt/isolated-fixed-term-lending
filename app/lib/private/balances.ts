// A wallet's private balance (story 9.3), from the browser.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  ESPL_PROGRAM_ID,
  ata,
  delegate,
  deposit,
  eataAmount,
  eataPda,
  initializeEata,
  permissionPda,
  undelegate,
  withdraw,
} from "./espl";
import { advance, newReceipt, saveReceipt } from "./receipts";
import { assertDevnet, validateTransaction } from "./tx-validator";

export type PrivateBalanceState = {
  /** An explicit owner-only permission from an older deposit blocks private loans. */
  loanBlocked: boolean;
  /** Private balance as the TEE reports it to the owner, when delegated. */
  privateAmount: bigint | null;
  /** True while the balance lives in the TEE. */
  delegated: boolean;
  exists: boolean;
  walletAmount: bigint;
  setupLamports: number;
};

async function tokenAmount(c: Connection, account: PublicKey): Promise<bigint | null> {
  try {
    return BigInt((await c.getTokenAccountBalance(account)).value.amount);
  } catch {
    return null;
  }
}

export async function readPrivateBalance(base: Connection, er: Connection | null, owner: PublicKey, mint: PublicKey): Promise<PrivateBalanceState> {
  const eata = eataPda(owner, mint);
  const isSol = mint.equals(NATIVE_MINT);
  const [info, perm, walletAmount, eataRent, permRent] = await Promise.all([
    base.getAccountInfo(eata),
    base.getAccountInfo(permissionPda(eata)),
    // wSOL is wrapped from plain SOL at deposit time, so the wallet figure is SOL.
    isSol ? base.getBalance(owner).then((l) => BigInt(Math.max(0, l - 10_000_000))) : tokenAmount(base, ata(owner, mint)),
    base.getMinimumBalanceForRentExemption(80),
    base.getMinimumBalanceForRentExemption(600),
  ]);
  const delegated = !!info?.owner.equals(DELEGATION_PROGRAM_ID);
  let privateAmount: bigint | null = null;
  if (delegated && er) privateAmount = await tokenAmount(er, ata(owner, mint));
  else if (info?.owner.equals(ESPL_PROGRAM_ID)) privateAmount = eataAmount(info.data);
  void permRent;
  return {
    loanBlocked: !!perm,
    privateAmount,
    delegated,
    exists: !!info,
    walletAmount: walletAmount ?? 0n,
    setupLamports: info ? 0 : eataRent,
  };
}

async function sendBase(base: Connection, signer: LoanSigner, tx: Transaction, intent: string, review: Parameters<typeof validateTransaction>[1]) {
  await assertDevnet(base);
  tx.feePayer = signer.publicKey;
  validateTransaction(tx, review);
  const wallet = signer.publicKey.toBase58();
  const { blockhash, lastValidBlockHeight } = await base.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  const signed = await signer.signTransaction(tx);
  const receipt = newReceipt(intent, "base");
  const sig = await base.sendRawTransaction(signed.serialize());
  saveReceipt(wallet, advance(receipt, { baseSignature: sig }));
  const res = await base.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  saveReceipt(wallet, advance(receipt, { baseSignature: sig, stage: res.value.err ? "failed" : "settled" }));
  if (res.value.err) throw new Error("Solana rejected this transaction.");
  return sig;
}

/** Commits the private balance back to Solana. Signed inside the TEE. */
async function bringToSolana(base: Connection, er: Connection, signer: LoanSigner, mint: PublicKey): Promise<bigint> {
  const owner = signer.publicKey;
  const tx = new Transaction().add(undelegate(owner, mint));
  tx.feePayer = owner;
  validateTransaction(tx, { feePayer: owner });
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  const signed = await signer.signTransaction(tx);
  const receipt = newReceipt("Move private balance to Solana", "er");
  const sig = await er.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  saveReceipt(owner.toBase58(), advance(receipt, { erSignature: sig, commitId: sig, stage: "settling" }));
  const eata = eataPda(owner, mint);
  for (let i = 0; i < 120; i++) {
    const info = await base.getAccountInfo(eata);
    if (info?.owner.equals(ESPL_PROGRAM_ID)) {
      saveReceipt(owner.toBase58(), advance(receipt, { erSignature: sig, commitId: sig, stage: "settled" }));
      return eataAmount(info.data);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("The balance has not reached Solana yet. Its receipt is saved; check again shortly.");
}

/** Wallet → private balance. Creates the private account and its owner-only permission the first time. */
export async function depositPrivately(base: Connection, er: Connection, signer: LoanSigner, mint: PublicKey, amount: bigint) {
  const owner = signer.publicKey;
  const eata = eataPda(owner, mint);
  let info = await base.getAccountInfo(eata);
  if (info?.owner.equals(DELEGATION_PROGRAM_ID)) {
    await bringToSolana(base, er, signer, mint);
    info = await base.getAccountInfo(eata);
  }
  // No explicit permission. Inside the TEE an un-permissioned eATA is already
  // readable only by its owner (outsiders see 0), and an explicit permission
  // would stop the private loan program from moving these funds (gateway 403).
  const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, mint), owner, mint));
  if (mint.equals(NATIVE_MINT)) {
    tx.add(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata(owner, mint), lamports: Number(amount) }),
      createSyncNativeInstruction(ata(owner, mint)),
    );
  }
  if (!info) tx.add(initializeEata(owner, mint));
  tx.add(deposit(owner, mint, amount));
  tx.add(delegate(owner, mint));
  return sendBase(base, signer, tx, "Deposit into private balance", {
    feePayer: owner,
    transfers: [{ kind: "deposit", owner, mint, amount }],
  });
}

/** Private balance → wallet. Brings the balance to Solana, then withdraws all of it. */
export async function withdrawPrivately(base: Connection, er: Connection, signer: LoanSigner, mint: PublicKey) {
  const owner = signer.publicKey;
  const info = await base.getAccountInfo(eataPda(owner, mint));
  const amount = info?.owner.equals(DELEGATION_PROGRAM_ID)
    ? await bringToSolana(base, er, signer, mint)
    : info
      ? eataAmount(info.data)
      : 0n;
  if (amount === 0n) throw new Error("There is nothing to withdraw.");
  return sendBase(base, signer, new Transaction().add(withdraw(owner, mint, amount)), "Withdraw private balance", {
    feePayer: owner,
    transfers: [{ kind: "withdraw", owner, mint, amount, destination: ata(owner, mint) }],
  });
}
