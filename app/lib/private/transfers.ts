// Private transfers (story 13.1): an SPL TransferChecked between two private
// balances, executed inside the TEE. Only sender and recipient can read either
// balance; Solana sees nothing until someone withdraws.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { createTransferCheckedInstruction } from "@solana/spl-token";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { ata } from "./espl";
import { advance, newReceipt, recordSignedReceipt, saveReceipt } from "./receipts";
import { ReviewMismatch, validateTransaction } from "./tx-validator";

export async function sendPrivately(er: Connection, signer: LoanSigner, mint: PublicKey, decimals: number, recipient: PublicKey, amount: bigint) {
  if (recipient.equals(signer.publicKey)) throw new ReviewMismatch("That is your own wallet.");
  const destination = ata(recipient, mint);
  // The recipient needs a private balance for this token; otherwise the account does not exist in the TEE.
  if (!(await er.getAccountInfo(destination))) {
    throw new Error("That wallet has no private balance for this token yet. Ask them to deposit once, then send.");
  }
  const tx = new Transaction().add(createTransferCheckedInstruction(ata(signer.publicKey, mint), mint, destination, signer.publicKey, amount, decimals));
  tx.feePayer = signer.publicKey;
  validateTransaction(tx, { feePayer: signer.publicKey, transfers: [{ kind: "send", owner: signer.publicKey, mint, amount, destination }] });
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  const signed = await signer.signTransaction(tx);
  const receipt = newReceipt(`Send privately to ${recipient.toBase58().slice(0, 4)}…`, "er");
  recordSignedReceipt(signer.publicKey.toBase58(), receipt, signed);
  const sig = await er.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  const res = await er.confirmTransaction(sig, "confirmed");
  saveReceipt(signer.publicKey.toBase58(), advance(receipt, { erSignature: sig, stage: res.value.err ? "failed" : "executed" }));
  if (res.value.err) throw new Error("The private rollup rejected the transfer. Check your private balance.");
  return sig;
}
