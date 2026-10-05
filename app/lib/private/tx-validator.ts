// Checks a transaction against what the user reviewed, before the wallet signs.
// Externally built transactions (Private Payments API, our own builders) all pass
// through here: programs, fee payer, mint, amount, destination, and network.
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ESPL_PROGRAM_ID, PERMISSION_PROGRAM_ID } from "./espl";
import { PRIVATE_PROGRAM_ID } from "./room-codec";

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export const ALLOWED_PROGRAMS = [
  SystemProgram.programId,
  ComputeBudgetProgram.programId,
  TOKEN_PROGRAM,
  ATA_PROGRAM,
  ESPL_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  PRIVATE_PROGRAM_ID,
];

export type ReviewedTransfer = {
  kind: "deposit" | "withdraw";
  owner: PublicKey;
  mint: PublicKey;
  amount: bigint;
  /** Token account that receives funds on withdraw. */
  destination?: PublicKey;
};

export type Review = { feePayer: PublicKey; transfers?: ReviewedTransfer[]; allowedPrograms?: PublicKey[] };

export class ReviewMismatch extends Error {}

function amountOf(data: Uint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true);
}

/** Throws `ReviewMismatch` naming the first difference from the review. */
export function validateTransaction(tx: Transaction, review: Review): void {
  const allowed = review.allowedPrograms ?? ALLOWED_PROGRAMS;
  if (!tx.feePayer?.equals(review.feePayer)) {
    throw new ReviewMismatch(`Fee payer is ${tx.feePayer?.toBase58() ?? "unset"}, not the reviewed ${review.feePayer.toBase58()}.`);
  }
  const pending = [...(review.transfers ?? [])];
  for (const [i, ix] of tx.instructions.entries()) {
    if (!allowed.some((p) => p.equals(ix.programId))) {
      throw new ReviewMismatch(`Instruction ${i + 1} calls ${ix.programId.toBase58()}, which is not an allowed program.`);
    }
    if (!ix.programId.equals(ESPL_PROGRAM_ID)) continue;
    const disc = ix.data[0];
    if (disc !== 2 && disc !== 3) continue;
    const kind = disc === 2 ? "deposit" : "withdraw";
    const amount = amountOf(ix.data);
    // deposit: [eata, vault, mint, source, vaultAta, owner, token]; withdraw: [owner, eata, vault, mint, vaultAta, dest, token]
    const mint = ix.keys[disc === 2 ? 2 : 3].pubkey;
    const owner = ix.keys[disc === 2 ? 5 : 0].pubkey;
    const destination = disc === 3 ? ix.keys[5].pubkey : undefined;
    const match = pending.findIndex(
      (t) =>
        t.kind === kind &&
        t.amount === amount &&
        t.mint.equals(mint) &&
        t.owner.equals(owner) &&
        (!t.destination || (destination && t.destination.equals(destination))),
    );
    if (match < 0) {
      throw new ReviewMismatch(`Instruction ${i + 1} would ${kind} ${amount} of ${mint.toBase58()}, which you did not review.`);
    }
    pending.splice(match, 1);
  }
  if (pending.length) throw new ReviewMismatch(`The transaction is missing a reviewed ${pending[0].kind}.`);
}

/** Refuses to sign for anything but Devnet. */
export async function assertDevnet(connection: Connection): Promise<void> {
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new ReviewMismatch("This connection is not Solana Devnet.");
}
