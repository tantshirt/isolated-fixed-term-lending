// Admin: fund the delegation program's ephemeral-balance escrow for this
// program (index 255). Magic Actions scheduled by `publish_receipt` are signed
// by this escrow on Solana, which is how `record_receipt` authenticates them.
// Run: npx tsx scripts/private/fund-action-escrow.ts
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createTopUpEscrowInstruction, escrowPdaFromEscrowAuthority } from "@magicblock-labs/ephemeral-rollups-sdk";
import { authority, base, program } from "../../spikes/lib/custody";

(async () => {
  const escrow = escrowPdaFromEscrowAuthority(program.programId, 255);
  const sig = await sendAndConfirmTransaction(
    base,
    new Transaction().add(createTopUpEscrowInstruction(escrow, program.programId, authority.publicKey, 10_000_000, 255)),
    [authority],
  );
  console.log("escrow", escrow.toBase58(), "funded", sig, "balance", await base.getBalance(escrow));
})();
