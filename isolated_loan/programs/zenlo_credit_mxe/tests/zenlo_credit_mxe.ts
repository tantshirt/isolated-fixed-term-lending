/**
 * Story 27.1 integration test on the Arcium localnet (`npm run test:integration`, needs Docker).
 * Preloaded accounts come from tests/fixtures/write-localnet-accounts.ts.
 *
 * Registers the `tier` circuit, requests the provider wallet's tier from its preloaded
 * HistoryAttestation (6 on time, nothing else) and SAS credential (band 3), waits for the MPC
 * callback and checks the TierResult: tier 3, computed from attestation slot 1000.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { ZenloCreditMxe } from "../target/types/zenlo_credit_mxe";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  uploadCircuit,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getLookupTableAddress,
  getMXEPublicKey,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";
import { addresses } from "./fixtures/write-localnet-accounts";
import idl from "../target/idl/zenlo_credit_mxe.json";

describe("zenlo_credit_mxe", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  // Built from the IDL directly (anchor.workspace needs cargo, which the Docker runner lacks).
  const program = new Program<ZenloCreditMxe>(idl as ZenloCreditMxe, anchor.getProvider());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumProgram = getArciumProgram(provider);
  const arciumEnv = getArciumEnv();

  it("computes tier 3 from a rollup-signed attestation and an SAS band", async () => {
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
    await initTierCompDef(owner);
    // Queueing needs the cluster's MXE keygen to have finished.
    await waitForMxeKeys(provider, program.programId);

    const borrower = owner.publicKey;
    const a = addresses(borrower);
    const computationOffset = new anchor.BN(randomBytes(8), "hex");
    const tierResult = PublicKey.findProgramAddressSync([Buffer.from("arcium-tier"), borrower.toBuffer()], program.programId)[0];

    const request = program.methods
      .requestTier(computationOffset)
      .accountsPartial({
        borrower,
        historyAttestation: a.history[0],
        loanConfig: a.config[0],
        creditConfig: a.credit[0],
        sasAttestation: a.sas[0],
        tierResult,
        computationAccount: getComputationAccAddress(arciumEnv.arciumClusterOffset, computationOffset),
        clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("tier")).readUInt32LE()),
      })
      .signers([owner]);
    let sig: string;
    try {
      sig = await request.rpc({ commitment: "confirmed" });
    } catch (e) {
      console.log("request_tier failed:", (e as { logs?: string[] }).logs ?? e);
      throw e;
    }
    console.log("request_tier", sig);

    const pending = await program.account.tierResult.fetch(tierResult);
    expect(pending.pending).to.equal(true);

    const finalizeSig = await awaitComputationFinalization(provider, computationOffset, program.programId, "confirmed");
    console.log("finalized", finalizeSig);

    const r = await program.account.tierResult.fetch(tierResult);
    expect(r.pending).to.equal(false);
    expect(r.tier).to.equal(3);
    expect(r.attestationSlot.toString()).to.equal("1000");
    expect(r.borrower.toBase58()).to.equal(borrower.toBase58());
  });

  async function initTierCompDef(owner: anchor.web3.Keypair): Promise<string> {
    const offset = getCompDefAccOffset("tier");
    const compDefPDA = PublicKey.findProgramAddressSync(
      [getArciumAccountBaseSeed("ComputationDefinitionAccount"), program.programId.toBuffer(), offset],
      getArciumProgramId(),
    )[0];
    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const sig = await program.methods
      .initCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount,
        addressLookupTable: getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot),
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    await uploadCircuit(provider, "tier", program.programId, fs.readFileSync("build/tier.arcis"), true, 500, {
      skipPreflight: true,
      preflightCommitment: "confirmed",
      commitment: "confirmed",
    });
    return sig;
  }
});

async function waitForMxeKeys(provider: anchor.AnchorProvider, programId: PublicKey, attempts = 240): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await getMXEPublicKey(provider, programId)) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("MXE keygen did not finish");
}

function readKpJson(path: string): anchor.web3.Keypair {
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path).toString())));
}
