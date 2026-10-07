import { utils } from "@coral-xyz/anchor";
import {
  Connection,
  Transaction,
  VersionedTransaction,
  type Signer,
} from "@solana/web3.js";
import { NETWORK, DEVNET_GENESIS_HASH, PROGRAM_ID } from "./constants";
import type { LoanSigner } from "./keypair-wallet";
import { assertOriginationAllowed } from "./ops-transaction";

export type SubmissionState =
  | "rejected"
  | "simulation-failed"
  | "confirmed-failure"
  | "uncertain";
export class SubmissionError extends Error {
  constructor(
    message: string,
    readonly state: SubmissionState,
    readonly signature?: string
  ) {
    super(message);
  }
}
export function signatureUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${
    NETWORK === "localnet" ? "custom" : "devnet"
  }`;
}
export type Pending = {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  intent?: string;
};
const memory = new Map<string, string>();
export function readSubmissionStorage(key: string): unknown {
  try {
    const raw =
      typeof window !== "undefined"
        ? localStorage.getItem(key)
        : memory.get(key);
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    throw new Error(
      `Submission recovery storage is unreadable (${key}). Restore browser storage access or recover the recorded transaction before removing this entry; no transaction was sent.`
    );
  }
}
export function writeSubmissionStorage(key: string, value?: unknown): void {
  try {
    if (typeof window !== "undefined") {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } else {
      if (value === undefined) memory.delete(key);
      else memory.set(key, JSON.stringify(value));
    }
  } catch {
    throw new Error(
      "Cannot save transaction recovery data. Enable browser storage before submitting; do not discard any existing recovery entry."
    );
  }
}
function pending(key: string): Pending | undefined {
  const value = readSubmissionStorage(key);
  if (value === undefined) return undefined;
  try {
    if (!value || typeof value !== "object") throw new Error();
    const p = value as Pending;
    if (
      typeof p.signature !== "string" ||
      utils.bytes.bs58.decode(p.signature).length !== 64 ||
      typeof p.blockhash !== "string" ||
      utils.bytes.bs58.decode(p.blockhash).length !== 32 ||
      !Number.isSafeInteger(p.lastValidBlockHeight) ||
      p.lastValidBlockHeight < 0 ||
      (p.intent !== undefined && typeof p.intent !== "string")
    )
      throw new Error();
    return p;
  } catch {
    throw new Error(
      `Saved transaction recovery data is invalid (${key}). Recover its signature using Explorer or restore the original entry before retrying; do not clear unresolved transactions.`
    );
  }
}
const save = writeSubmissionStorage;
const active = new Set<string>();
/** Web Locks coordinate storage and submissions across tabs. Unsupported browsers fail closed. */
export async function withSubmissionLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  if (active.has(key))
    throw new SubmissionError(
      "This transaction is already being submitted.",
      "uncertain"
    );
  active.add(key);
  try {
    if (typeof window === "undefined") return await operation();
    if (typeof navigator === "undefined" || !navigator.locks?.request)
      throw new Error(
        "Safe cross-tab transaction coordination is unavailable. Use a browser with Web Locks support on HTTPS or localhost; no transaction was sent."
      );
    return await navigator.locks.request(
      key,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock)
          throw new SubmissionError(
            "Another tab is submitting for this wallet. Finish or reconcile that transaction there first.",
            "uncertain"
          );
        return operation();
      }
    );
  } finally {
    active.delete(key);
  }
}
export async function reconcileSubmission(
  connection: Connection,
  record: Pending
): Promise<"confirmed" | "expired"> {
  const {
    value: [status],
  } = await connection.getSignatureStatuses([record.signature], {
    searchTransactionHistory: true,
  });
  if (status?.err)
    throw new SubmissionError(
      `Transaction failed: ${JSON.stringify(status.err)}`,
      "confirmed-failure",
      record.signature
    );
  if (
    status?.confirmationStatus === "confirmed" ||
    status?.confirmationStatus === "finalized"
  )
    return "confirmed";
  if (
    !status &&
    (await connection.getBlockHeight("finalized")) > record.lastValidBlockHeight
  )
    return "expired";
  throw new SubmissionError(
    "Submission is still pending. Check the saved signature before retrying.",
    "uncertain",
    record.signature
  );
}
/** Simulate before wallet signing. Save the signature before sending any bytes. */
export async function submitTransaction(
  connection: Connection,
  signer: LoanSigner,
  tx: Transaction,
  ephemeralSigners: Signer[] = []
): Promise<string> {
  const intent = tx.instructions
    .map((i) =>
      [
        i.programId.toBase58(),
        i.keys
          .map((k) => `${k.pubkey}:${k.isSigner}:${k.isWritable}`)
          .join(","),
        i.data.toString("hex"),
      ].join(":")
    )
    .join("|");
  const key = `tenor:pending:${NETWORK}:${PROGRAM_ID}:${signer.publicKey}`;
  return withSubmissionLock(key, async () => {
    if (
      NETWORK === "devnet" &&
      (await connection.getGenesisHash()) !== DEVNET_GENESIS_HASH
    )
      throw new Error("RPC is not Solana Devnet; refusing to sign");
    const prior = pending(key);
    if (prior) {
      try {
        if ((await reconcileSubmission(connection, prior)) === "confirmed") {
          save(key);
          if (prior.intent === intent) return prior.signature;
        }
        save(key);
      } catch (error) {
        if (
          error instanceof SubmissionError &&
          error.state === "confirmed-failure"
        )
          save(key);
        if (error instanceof SubmissionError) throw error;
        throw new SubmissionError(
          "Could not reconcile the previous submission. Do not submit again yet.",
          "uncertain",
          prior.signature
        );
      }
    }
    const lifetime = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = lifetime.blockhash;
    const simulation = await connection.simulateTransaction(
      new VersionedTransaction(tx.compileMessage()),
      { sigVerify: false, commitment: "confirmed" }
    );
    if (simulation.value.err)
      throw new SubmissionError(
        `Simulation failed: ${JSON.stringify(simulation.value.err)}. ${
          simulation.value.logs?.slice(-4).join(" ") ?? ""
        }`,
        "simulation-failed"
      );
    if (ephemeralSigners.length) tx.partialSign(...ephemeralSigners);
    await assertOriginationAllowed(tx);
    let signed: Transaction;
    try {
      signed = await signer.signTransaction(tx);
    } catch {
      throw new SubmissionError(
        "Wallet signing was cancelled or rejected.",
        "rejected"
      );
    }
    if (!signed.signature)
      throw new Error("Wallet returned an unsigned transaction");
    const signature = utils.bytes.bs58.encode(signed.signature);
    const record = { signature, ...lifetime, intent };
    save(key, record);
    try {
      await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      const result = await connection.confirmTransaction(record, "confirmed");
      if (result.value.err) {
        save(key);
        throw new SubmissionError(
          `Transaction failed: ${JSON.stringify(result.value.err)}`,
          "confirmed-failure",
          signature
        );
      }
      save(key);
      return signature;
    } catch (error) {
      if (error instanceof SubmissionError) throw error;
      try {
        if ((await reconcileSubmission(connection, record)) === "confirmed") {
          save(key);
          return signature;
        }
      } catch (reconcileError) {
        if (
          reconcileError instanceof SubmissionError &&
          reconcileError.state === "confirmed-failure"
        ) {
          save(key);
          throw reconcileError;
        }
      }
      throw new SubmissionError(
        `Submission outcome is unknown. Check ${signatureUrl(
          signature
        )}; retry will reconcile this signature first.`,
        "uncertain",
        signature
      );
    }
  });
}
