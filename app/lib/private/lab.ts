// The learning lab from the browser: a VRF scenario request, an opt-in SOAR
// registration (reviewed before signing), and the achievement claim.
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import idl from "@/idl/private_loan.json";
import type { LoanSigner } from "@/lib/keypair-wallet";
import type { LabOutcome } from "@/lib/lab-scenario";
import { PRIVATE_PROGRAM_ID } from "./room-codec";

const SOAR_PROGRAM = new PublicKey("SoarNNzwQHMwcfdkdLc6kvbkoMSxcHy89gTHrjhJYkk");
export const labScenarioPda = (learner: PublicKey) => PublicKey.findProgramAddressSync([new TextEncoder().encode("lab"), learner.toBytes()], PRIVATE_PROGRAM_ID)[0];

export async function readLabScenario(base: Connection, learner: PublicKey) {
  const info = await base.getAccountInfo(labScenarioPda(learner));
  if (!info) return null;
  const d = info.data;
  return { randomness: Uint8Array.from(d.subarray(40, 72)), ready: d[72] === 1, rounds: new DataView(d.buffer, d.byteOffset).getUint32(73, true) };
}

export async function requestScenario(base: Connection, signer: LoanSigner) {
  const program = new Program(idl as Idl, new AnchorProvider(base, signer, { commitment: "confirmed" }));
  const seed = crypto.getRandomValues(new Uint8Array(1))[0];
  return program.methods.requestScenario(seed).accountsPartial({ learner: signer.publicKey }).rpc();
}

/**
 * A wallet without Devnet SOL can have its first draw sponsored. The transaction must be exactly: the sponsor
 * sending this wallet the scenario's rent and VRF fee, then request_scenario for this wallet. Anything else is not signed.
 */
export async function requestSponsoredScenario(base: Connection, signer: LoanSigner) {
  const r = await (await fetch("/api/lab/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: signer.publicKey.toBase58() }) })).json();
  if (!r.transaction) throw new Error(r.error ?? "Could not sponsor this draw.");
  const tx = Transaction.from(Buffer.from(r.transaction, "base64"));
  const [fund, request, ...rest] = tx.instructions;
  const me = signer.publicKey;
  const ok =
    rest.length === 0 &&
    !!fund && fund.programId.equals(SystemProgram.programId) && fund.keys[1]?.pubkey.equals(me) && fund.keys[0]?.pubkey.equals(tx.feePayer!) &&
    !!request && request.programId.equals(PRIVATE_PROGRAM_ID) && request.keys[0]?.pubkey.equals(me) && request.keys[1]?.pubkey.equals(labScenarioPda(me));
  if (!ok) throw new Error("The sponsored transaction does not match what was described; nothing was signed.");
  const signed = await signer.signTransaction(tx);
  const sig = await base.sendRawTransaction(signed.serialize());
  await base.confirmTransaction(sig, "confirmed");
  return sig;
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
  const { blockhash, lastValidBlockHeight } = await base.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  const signed = await signer.signTransaction(tx);
  const sig = await base.sendRawTransaction(signed.serialize());
  await base.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

export async function claimAchievement(wallet: PublicKey, answer: LabOutcome) {
  const r = await fetch("/api/lab/achievement", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.toBase58(), answer }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? "Could not record the achievement.");
  return body as { already: boolean; signature?: string };
}
