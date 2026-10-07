import type { Connection, Transaction } from "@solana/web3.js";
import { base58 } from "@scure/base";
import type { LoanSigner } from "../keypair-wallet";
import { readSubmissionStorage, writeSubmissionStorage, withSubmissionLock, reconcileSubmission, submitTransaction, SubmissionError, type Pending } from "../transaction-lifecycle";
import type { RampsEnv, ReviewedTransfer } from "./moneygram";

type CashTransfer = Pending & { amountAtoms: string; mint: string; to: string; confirmed: boolean };

/** A provider retry must reconcile the original transfer, even after its on-chain confirmation. */
export async function submitCashTransfer(
  connection: Connection,
  signer: LoanSigner,
  tx: Transaction,
  rampsId: string,
  env: RampsEnv,
  transfer: ReviewedTransfer,
  recordSigned: (signature: string) => Promise<unknown>,
): Promise<string> {
  if (!rampsId) throw new Error("MoneyGram has not created this cash-out yet.");
  const key = `zenlo:cash-transfer:${env}:${signer.publicKey}:${rampsId}`;
  return withSubmissionLock(key, async () => {
    let saved = readSubmissionStorage(key) as CashTransfer | undefined;
    if (saved !== undefined) {
      try {
        if (!saved || base58.decode(saved.signature).length !== 64 || base58.decode(saved.blockhash).length !== 32 ||
          !Number.isSafeInteger(saved.lastValidBlockHeight) || saved.lastValidBlockHeight < 0 || typeof saved.confirmed !== "boolean") throw new Error();
      } catch {
        throw new Error("Cash-out recovery data is invalid. Recover the recorded transfer before retrying.");
      }
      if (saved.to !== transfer.to || saved.mint !== transfer.mint || saved.amountAtoms !== transfer.atoms.toString()) {
        throw new Error("This cash-out already has a different transfer recorded. Reconcile it before continuing.");
      }
      if (!saved.confirmed) {
        try {
          if (await reconcileSubmission(connection, saved) === "confirmed") {
            saved = { ...saved, confirmed: true };
            writeSubmissionStorage(key, saved);
          } else {
            writeSubmissionStorage(key);
            saved = undefined;
          }
        } catch (e) {
          if (e instanceof SubmissionError && e.state === "confirmed-failure") writeSubmissionStorage(key);
          throw e;
        }
      }
    }
    if (!saved) {
      try {
        const signature = await submitTransaction(connection, signer, tx, [], async (pending) => {
          saved = { ...pending, amountAtoms: transfer.atoms.toString(), mint: transfer.mint, to: transfer.to, confirmed: false };
          writeSubmissionStorage(key, saved);
        });
        // submitTransaction also reconciles the wallet's pending send from another tab/reload.
        const recorded = saved as CashTransfer | undefined;
        if (!recorded || recorded.signature !== signature) throw new Error("Cash-out signature needs reconciliation before continuing.");
        saved = { ...recorded, confirmed: true };
        writeSubmissionStorage(key, saved);
      } catch (e) {
        if (e instanceof SubmissionError && e.state === "confirmed-failure") writeSubmissionStorage(key);
        throw e;
      }
    }
    await recordSigned(saved.signature);
    return saved.signature;
  });
}
