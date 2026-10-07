import { PublicKey, Transaction, type AccountMeta, type TransactionInstruction } from "@solana/web3.js";
import { permissionPda } from "./espl";
import { v2Pda, type DeskStateV2 } from "./v2-codec";

/** Every historical policy followed by every book entry, each with its permission account.
 * The program checks this exact list before changing membership or any permission.
 */
export function deskMembershipAccounts(anchor: PublicKey, state: Pick<DeskStateV2, "policyVersion" | "nextLoanSeq">): AccountMeta[] {
  const records = [
    ...Array.from({ length: state.policyVersion }, (_, i) => v2Pda.deskPolicy(anchor, i + 1)),
    ...Array.from({ length: state.nextLoanSeq }, (_, i) => v2Pda.deskLoan(anchor, i)),
  ];
  return records.flatMap((pubkey) => [
    { pubkey, isSigner: false, isWritable: false },
    { pubkey: permissionPda(pubkey), isSigner: false, isWritable: true },
  ]);
}

/** Measure the actual serialized transaction before opening the wallet. Access updates must
 * remain atomic; never split an oversized update and leave old metadata permissions behind.
 */
export function assertMembershipTransactionFits(ix: TransactionInstruction, payer: PublicKey): void {
  try {
    new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() })
      .add(ix).serialize({ requireAllSignatures: false, verifySignatures: false });
  } catch {
    throw new Error("This desk's access update no longer fits in one transaction. No membership or permissions were changed.");
  }
}
