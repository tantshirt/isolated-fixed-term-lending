import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { PublicKey, type Transaction, type Signer } from "@solana/web3.js";
import { getConnection } from "./program";
import {
  PYTH_RECEIVER_PROGRAM_ID,
  PYTH_PUSH_PROGRAM_ID,
  PYTH_PRICE_SHARD,
  PYTH_PRICE_UPDATE_ACCOUNT,
} from "./constants";
import type { LoanSigner } from "./keypair-wallet";
import { submitTransaction } from "./transaction-lifecycle";

type Posting = {
  batches: { tx: Transaction; signers: Signer[] }[];
  next: number;
  account: PublicKey;
  signatures: string[];
};
const sessions = new Map<string, Posting>();
/** Explicit wallet-funded Full-verification update. Reinvoke to resume an interrupted batch. */
export async function sendPythUpdate(
  signer: LoanSigner
): Promise<{ priceUpdateAccount: PublicKey; signatures: string[] }> {
  const connection = getConnection();
  const key = signer.publicKey.toBase58();
  let session = sessions.get(key);
  if (!session) {
    const response = await fetch("/api/pyth-update", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok)
      throw new Error(body.error || "Unable to fetch a Pyth update");
    const receiver = new PythSolanaReceiver({
      connection,
      wallet: signer as ConstructorParameters<
        typeof PythSolanaReceiver
      >[0]["wallet"],
      receiverProgramId: PYTH_RECEIVER_PROGRAM_ID,
      pushOracleProgramId: PYTH_PUSH_PROGRAM_ID,
    });
    const builder = receiver.newTransactionBuilder({
      closeUpdateAccounts: true,
    });
    await builder.addUpdatePriceFeed(body.data, PYTH_PRICE_SHARD);
    session = {
      batches: builder.buildLegacyTransactions({}),
      next: 0,
      account: PYTH_PRICE_UPDATE_ACCOUNT,
      signatures: [],
    };
    sessions.set(key, session);
  }
  while (session.next < session.batches.length) {
    const batch = session.batches[session.next];
    session.signatures.push(
      await submitTransaction(connection, signer, batch.tx, batch.signers)
    );
    session.next++;
  }
  sessions.delete(key);
  return {
    priceUpdateAccount: session.account,
    signatures: session.signatures,
  };
}
