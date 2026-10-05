// Returns every custody balance owned by this wallet to the wallet.
// Delegated eATAs are undelegated first. Safe to rerun.
// Run: npx tsx spikes/recover-custody.ts
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { ESPL, authority, base, eataPda, eataState, program, sendEr, teeConnection, undelegateIx, waitFor, withdrawIx } from "./lib/custody";

async function main() {
  const er = await teeConnection(authority);
  const mine = (await program.account.custody.all()).filter((c: { account: { authority: PublicKey } }) =>
    c.account.authority.equals(authority.publicKey),
  );
  for (const c of mine) {
    const custody: PublicKey = c.publicKey;
    const mint: PublicKey = c.account.mint;
    const eata = eataPda(custody, mint);
    let state = await eataState(base, eata);
    if (!state) continue;
    if (state.owner.equals(DELEGATION_PROGRAM_ID)) {
      console.log(`undelegating ${custody.toBase58()}`, await sendEr(er, await undelegateIx(custody, mint)));
      state = await waitFor("eATA back on base", () => eataState(base, eata), (s) => s.owner.equals(ESPL));
    }
    if (state.amount > 0n) {
      const sig = await sendAndConfirmTransaction(base, new Transaction().add(await withdrawIx(custody, mint, state.amount)), [authority]);
      console.log(`withdrew ${state.amount} of ${mint.toBase58()} from ${custody.toBase58()}`, sig);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
