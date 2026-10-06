// The learning lab from the browser: a VRF scenario request, an opt-in SOAR
// registration (reviewed before signing), and the achievement claim.
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemInstruction, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import idl from "@/idl/private_loan.json";
import type { LoanSigner } from "@/lib/keypair-wallet";
import type { LabOutcome } from "@/lib/lab-scenario";
import { advance, newReceipt, recordSignedReceipt, saveReceipt } from "./receipts";
import { assertDevnet } from "./tx-validator";
import { PRIVATE_PROGRAM_ID } from "./room-codec";

const SOAR_PROGRAM = new PublicKey("SoarNNzwQHMwcfdkdLc6kvbkoMSxcHy89gTHrjhJYkk");
export const labScenarioPda = (learner: PublicKey) => PublicKey.findProgramAddressSync([new TextEncoder().encode("lab"), learner.toBytes()], PRIVATE_PROGRAM_ID)[0];

async function submitLab(base: Connection, signer: LoanSigner, tx: Transaction, intent: string, sponsored = false) {
  await assertDevnet(base);
  if (!sponsored) {
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
  }
  const signed = await signer.signTransaction(tx);
  const wallet = signer.publicKey.toBase58();
  const receipt = newReceipt(intent, "base");
  recordSignedReceipt(wallet, receipt, signed);
  const sig = await base.sendRawTransaction(signed.serialize());
  const confirmation = await base.confirmTransaction(sig, "confirmed");
  saveReceipt(wallet, advance(receipt, { baseSignature: sig, stage: confirmation.value.err ? "failed" : "settled" }));
  if (confirmation.value.err) throw new Error("The learning action did not complete. Its signature is saved in your receipts.");
  return sig;
}

export async function readLabScenario(base: Connection, learner: PublicKey) {
  const info = await base.getAccountInfo(labScenarioPda(learner));
  if (!info) return null;
  const d = info.data;
  return { randomness: Uint8Array.from(d.subarray(40, 72)), ready: d[72] === 1, rounds: new DataView(d.buffer, d.byteOffset).getUint32(73, true) };
}

export async function requestScenario(base: Connection, signer: LoanSigner) {
  const program = new Program(idl as Idl, new AnchorProvider(base, signer, { commitment: "confirmed" }));
  const seed = crypto.getRandomValues(new Uint8Array(1))[0];
  const ix = await program.methods.requestScenario(seed).accountsPartial({ learner: signer.publicKey }).instruction();
  return submitLab(base, signer, new Transaction().add(ix), "Draw a learning scenario");
}

/**
 * A wallet without Devnet SOL can have its first draw sponsored. The transaction must be exactly: the sponsor
 * sending this wallet the scenario's rent and VRF fee, then request_first_scenario for this wallet. Anything else is not signed.
 */
export async function requestSponsoredScenario(base: Connection, signer: LoanSigner) {
  const r = await (await fetch("/api/lab/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: signer.publicKey.toBase58() }) })).json();
  if (!r.transaction) throw new Error(r.error ?? "Could not sponsor this draw.");
  const tx = Transaction.from(Buffer.from(r.transaction, "base64"));
  await assertDevnet(base);
  const rent = await base.getMinimumBalanceForRentExemption(86);
  const program = new Program(idl as Idl, new AnchorProvider(base, signer, { commitment: "confirmed" }));
  const seed = tx.instructions[1]?.data[8] ?? 0;
  const expected = await program.methods.requestFirstScenario(seed).accountsPartial({ learner: signer.publicKey }).instruction();
  assertSponsoredScenario(tx, signer.publicKey, rent, expected);
  return submitLab(base, signer, tx, "Draw a sponsored learning scenario", true);
}

/** Verify every funded amount, account and operation before requesting a wallet signature. */
export function assertSponsoredScenario(tx: Transaction, me: PublicKey, rent: number, expected: TransactionInstruction): void {
  const [fund, request] = tx.instructions;
  const reject = () => { throw new Error("The sponsored transaction does not match what was described; nothing was signed."); };
  if (tx.instructions.length !== 2 || !fund || !request || !tx.feePayer || tx.feePayer.equals(me)) return reject();
  let transfer: ReturnType<typeof SystemInstruction.decodeTransfer>;
  try { transfer = SystemInstruction.decodeTransfer(fund); } catch { return reject(); }
  if (!transfer.fromPubkey.equals(tx.feePayer) || !transfer.toPubkey.equals(me) || BigInt(transfer.lamports) !== BigInt(rent + 500_000)) return reject();
  if (!request.programId.equals(expected.programId) || !request.data.equals(expected.data) || request.keys.length !== expected.keys.length) return reject();
  if (!request.keys.every((key, i) => key.pubkey.equals(expected.keys[i].pubkey) && key.isSigner === expected.keys[i].isSigner && key.isWritable === expected.keys[i].isWritable)) return reject();
}

/** Builds the SOAR registration on the server, checks it only touches SOAR and the system program, then signs. */
export async function registerForAchievements(base: Connection, signer: LoanSigner) {
  const r = await (await fetch(`/api/lab/register?wallet=${signer.publicKey.toBase58()}`)).json();
  if (r.error) throw new Error(r.error);
  if (!r.transaction) return null; // already opted in
  const tx = Transaction.from(Buffer.from(r.transaction, "base64"));
  const allowed = [SOAR_PROGRAM, SystemProgram.programId];
  if (!tx.feePayer?.equals(signer.publicKey) || !tx.instructions.every((ix) => allowed.some((p) => p.equals(ix.programId)))) {
    throw new Error("The registration does not match what was described; nothing was signed.");
  }
  return submitLab(base, signer, tx, "Register for public learning achievements");
}

export async function claimAchievement(wallet: PublicKey, answer: LabOutcome) {
  const r = await fetch("/api/lab/achievement", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.toBase58(), answer }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? "Could not record the achievement.");
  return body as { already: boolean; signature?: string };
}
