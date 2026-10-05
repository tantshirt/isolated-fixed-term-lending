// Admin, once: create the liquidation pool and its delegated eATAs.
// Run: npx tsx scripts/private/init-pool.ts
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { ESPL_PROGRAM_ID, eataPda } from "../../../app/lib/private/espl";
import { authority, base, program } from "../../spikes/lib/custody";
import { USDC, WSOL } from "./lib/parties";

(async () => {
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from("liq-pool")], program.programId);
  if (await base.getAccountInfo(pool)) return console.log("pool exists", pool.toBase58());
  const ue = eataPda(pool, USDC);
  const we = eataPda(pool, WSOL);
  const sig = await sendAndConfirmTransaction(
    base,
    new Transaction().add(
      await program.methods
        .initLiquidationPool()
        .accountsPartial({
          admin: authority.publicKey,
          pool,
          usdcMint: USDC,
          wsolMint: WSOL,
          usdcEata: ue,
          wsolEata: we,
          usdcBuffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(ue, ESPL_PROGRAM_ID),
          usdcRecord: delegationRecordPdaFromDelegatedAccount(ue),
          usdcMetadata: delegationMetadataPdaFromDelegatedAccount(ue),
          wsolBuffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(we, ESPL_PROGRAM_ID),
          wsolRecord: delegationRecordPdaFromDelegatedAccount(we),
          wsolMetadata: delegationMetadataPdaFromDelegatedAccount(we),
          esplProgram: ESPL_PROGRAM_ID,
          delegationProgram: DELEGATION_PROGRAM_ID,
        })
        .instruction(),
    ),
    [authority],
  );
  console.log("pool created", pool.toBase58(), sig);
})();
