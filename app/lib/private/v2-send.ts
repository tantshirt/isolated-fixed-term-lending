// Shared signing path for private_loan_v2: every transaction is checked against what the user
// reviewed, signed by the wallet, sent, and recorded as a receipt.
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import idl from "@/idl/private_loan_v2.json";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { assertOriginationAllowed } from "@/lib/ops-transaction";
import { MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID } from "./espl";
import { advance, newReceipt, recordSignedReceipt, saveReceipt } from "./receipts";
import { assertDevnet, validateTransaction } from "./tx-validator";
import { PRIVATE_V2_ID } from "./v2-codec";

export const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
export const ER_ONLY = { vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID, permissionProgram: PERMISSION_PROGRAM_ID };

export function programV2(base: Connection, signer: LoanSigner) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program({ ...(idl as Idl), address: PRIVATE_V2_ID.toBase58() }, new AnchorProvider(base, signer, { commitment: "confirmed" })) as any;
}

const CODES = Object.fromEntries(((idl as Idl).errors ?? []).map((e) => [e.code, e.name]));

/** Program errors in words a borrower or lender can act on. */
export function explainV2Error(message: string): string {
  const custom = /"Custom":(\d+)/.exec(message)?.[1];
  const name = custom ? CODES[Number(custom)] : /Error Code: (\w+)/.exec(message)?.[1];
  const words: Record<string, string> = {
    StalePrice: "The SOL price is more than 60 seconds old. Devnet refreshes it every few minutes; try again shortly.",
    StaleRevision: "The terms changed since you looked. Review the current version and approve that one.",
    InsufficientCollateral: "At today's price the collateral is not enough for the starting LTV.",
    WrongStatus: "This loan is no longer in that state. Refresh to see where it stands.",
    CompetingOfferAccepted: "This request already has an accepted offer.",
    AuditorMismatch: "The auditors you were shown do not match the loan. Do not sign; ask the lender to share the list again.",
    PolicyViolation: "These terms are outside the desk's policy.",
    NotDeskLender: "This wallet is not a lender on that desk.",
    NotDeskAdmin: "Only a desk administrator can do that.",
    LastDeskAdmin: "A desk needs at least one administrator.",
    InvalidTerms: "These terms are outside ZenLo's limits.",
    NotLender: "Only this loan's lender can do that.",
    NotBorrower: "Only this loan's borrower can do that.",
  };
  if (name && words[name]) return words[name];
  if (/insufficient funds|0x1\b/i.test(message)) return "Your private balance does not hold enough for this.";
  return name ?? message;
}

export async function sendEr(er: Connection, signer: LoanSigner, ix: TransactionInstruction, intent: string, revision?: number): Promise<string> {
  const wallet = signer.publicKey.toBase58();
  const receipt = newReceipt(intent, "er", revision);
  const tx = new Transaction().add(ix);
  tx.feePayer = signer.publicKey;
  validateTransaction(tx, { feePayer: signer.publicKey });
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  await assertOriginationAllowed(tx);
  const signed = await signer.signTransaction(tx);
  recordSignedReceipt(wallet, receipt, signed);
  const sig = await er.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  saveReceipt(wallet, advance(receipt, { erSignature: sig }));
  const res = await er.confirmTransaction(sig, "confirmed");
  if (res.value.err) {
    const t = await er.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    const named = t?.meta?.logMessages?.find((l) => l.includes("Error Code:")) ?? JSON.stringify(res.value.err);
    saveReceipt(wallet, advance(receipt, { erSignature: sig, stage: "failed", error: named }));
    throw new Error(explainV2Error(named));
  }
  saveReceipt(wallet, advance(receipt, { erSignature: sig, stage: "executed" }));
  return sig;
}

export async function sendBase(base: Connection, signer: LoanSigner, ixs: TransactionInstruction[], intent: string): Promise<string> {
  const wallet = signer.publicKey.toBase58();
  const receipt = newReceipt(intent, "base");
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signer.publicKey;
  validateTransaction(tx, { feePayer: signer.publicKey });
  await assertDevnet(base);
  const { blockhash, lastValidBlockHeight } = await base.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  await assertOriginationAllowed(tx);
  const signed = await signer.signTransaction(tx);
  recordSignedReceipt(wallet, receipt, signed);
  const sig = await base.sendRawTransaction(signed.serialize());
  saveReceipt(wallet, advance(receipt, { baseSignature: sig }));
  const confirmation = await base.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) {
    saveReceipt(wallet, advance(receipt, { baseSignature: sig, stage: "failed" }));
    throw new Error("Solana rejected this transaction. Its receipt is saved.");
  }
  saveReceipt(wallet, advance(receipt, { baseSignature: sig, stage: "settled" }));
  return sig;
}

/** Waits for a freshly delegated account to appear in the rollup. */
export async function waitInEr(er: Connection, account: PublicKey, seconds = 30) {
  for (let i = 0; i < seconds && !(await er.getAccountInfo(account)); i++) await new Promise((r) => setTimeout(r, 1000));
}
