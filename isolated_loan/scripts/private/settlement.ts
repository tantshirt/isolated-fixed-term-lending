// Story 12.1 live on the Devnet TEE: a 60-second private loan gets a Hydra
// watch, and Lendspan's cranker (the same code the Vercel Cron route runs)
// settles the expiry with no manual claim. The cranker cannot read the loan.
// Liquidation needs a real price drop, which Devnet cannot be made to produce;
// it is covered by `cargo test --test settle` (LiteSVM, real Pyth-owned account).
// Run: npx tsx scripts/private/settlement.ts
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { collateralValueUsdc, debt as debtOf } from "../../../app/lib/loan-math";
import { ESPL_PROGRAM_ID, ata, eataPda } from "../../../app/lib/private/espl";
import { decodeLoanTerms, loanAnchorPda, loanTermsPda } from "../../../app/lib/private/loan-codec";
import { ROLE, roomAnchorPda, roomStatePda, roomThreadPda } from "../../../app/lib/private/room-codec";
import { HYDRA_EPHEMERAL, runCranker } from "../../../app/lib/server/cranker";
import { recordGate } from "../../spikes/lib/evidence";
import { base, program, sleep, teeConnection, waitFor } from "../../spikes/lib/custody";
import { USDC, WSOL, cashOut, makePrivate, newParty, privateBalance, type Party } from "./lib/parties";

const PYTH = PublicKey.findProgramAddressSync(
  [Buffer.from([0, 0]), Buffer.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex")],
  new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT"),
)[0];

const checks: Record<string, unknown> = {};
const fail: string[] = [];
const expect = (name: string, ok: boolean, detail: unknown) => {
  checks[name] = { ok, detail };
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail);
  if (!ok) fail.push(name);
};

async function send(p: Party, ix: TransactionInstruction): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const tx = new Transaction().add(ix);
    tx.feePayer = p.kp.publicKey;
    tx.recentBlockhash = (await p.er.getLatestBlockhash()).blockhash;
    tx.sign(p.kp);
    const sig = await p.er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const res = await p.er.confirmTransaction(sig, "confirmed");
    if (!res.value.err) return sig;
    const err = JSON.stringify(res.value.err);
    if (err.includes('"Custom":101') && attempt < 12) {
      await sleep(10_000);
      continue;
    }
    throw new Error(`${sig} failed: ${err}`);
  }
}

async function main() {
  const cranker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../../.local/cranker.json", import.meta.url), "utf8"))));
  const crankerEr = await teeConnection(cranker);
  const lender = await newParty("lender", 120_000_000, 110_000n);
  const borrower = await newParty("borrower", 150_000_000, 10_000n);

  const d = (await base.getAccountInfo(PYTH))!.data;
  const off = 8 + 32 + (d[40] === 0 ? 2 : 1) + 32;
  const [price, conf, exponent] = [d.readBigInt64LE(off), d.readBigUInt64LE(off + 8), d.readInt32LE(off + 16)];
  const principal = 100_000n;
  const target = (debtOf(principal, 500) * 10_000n) / 5_000n;
  let collateral = (target * 10n ** BigInt(3 - exponent)) / (price - conf) + 1n;
  while (collateralValueUsdc(collateral, price, conf, exponent) < target) collateral += 1n;

  await makePrivate(lender, USDC, 110_000n);
  await makePrivate(lender, WSOL, 0n);
  await makePrivate(borrower, USDC, 10_000n);
  await makePrivate(borrower, WSOL, collateral);

  const roomId = randomBytes(32);
  const room = roomAnchorPda(roomId);
  const roomState = roomStatePda(room);
  await sendAndConfirmTransaction(
    base,
    new Transaction().add(
      await program.methods.openRoom([...roomId]).accountsPartial({ creator: lender.kp.publicKey, anchor: room }).instruction(),
      await program.methods.delegateRoom([...roomId]).accountsPartial({ creator: lender.kp.publicKey, anchor: room }).instruction(),
    ),
    [lender.kp],
  );
  await waitFor("room in ER", () => lender.er.getAccountInfo(room), () => true);
  const rooms = {
    anchor: room,
    state: roomState,
    statePermission: permissionPdaFromAccount(roomState),
    thread: roomThreadPda(room),
    threadPermission: permissionPdaFromAccount(roomThreadPda(room)),
    vault: EPHEMERAL_VAULT_ID,
    magicProgram: MAGIC_PROGRAM_ID,
    permissionProgram: PERMISSION_PROGRAM_ID,
  };
  await send(lender, await program.methods.initRoom().accountsPartial({ owner: lender.kp.publicKey, ...rooms }).instruction());
  await send(lender, await program.methods.inviteMember(borrower.kp.publicKey, ROLE.borrower).accountsPartial({ owner: lender.kp.publicKey, ...rooms }).instruction());

  const loanId = randomBytes(32);
  const anchor = loanAnchorPda(loanId);
  const ue = eataPda(anchor, USDC);
  const we = eataPda(anchor, WSOL);
  await sendAndConfirmTransaction(
    base,
    new Transaction().add(
      await program.methods
        .createLoan([...loanId])
        .accountsPartial({
          lender: lender.kp.publicKey,
          anchor,
          room,
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
      await program.methods.delegateLoan([...loanId]).accountsPartial({ lender: lender.kp.publicKey, anchor }).instruction(),
    ),
    [lender.kp],
  );
  await waitFor("loan in ER", () => lender.er.getAccountInfo(anchor), () => true);
  await send(
    lender,
    await program.methods
      .proposeTerms({
        borrower: borrower.kp.publicKey,
        principal: new BN(principal.toString()),
        interestBps: 500,
        durationSeconds: new BN(60),
        collateralAmount: new BN(collateral.toString()),
        maxLtvBps: 7000,
        liquidationLtvBps: 8000,
      })
      .accountsPartial({
        lender: lender.kp.publicKey,
        anchor,
        room,
        roomState,
        terms: loanTermsPda(anchor),
        termsPermission: permissionPdaFromAccount(loanTermsPda(anchor)),
        vault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        permissionProgram: PERMISSION_PROGRAM_ID,
      })
      .instruction(),
  );
  await send(
    lender,
    await program.methods
      .fundLoan(1)
      .accountsPartial({ lender: lender.kp.publicKey, anchor, terms: loanTermsPda(anchor), lenderUsdc: ata(lender.kp.publicKey, USDC), loanUsdc: ata(anchor, USDC) })
      .instruction(),
  );
  const age = async () => {
    const x = (await borrower.er.getAccountInfo(PYTH))!.data;
    return Math.floor(Date.now() / 1000) - Number(x.readBigInt64LE(8 + 32 + (x[40] === 0 ? 2 : 1) + 32 + 20));
  };
  await waitFor("fresh SOL/USD price in the TEE", age, (a) => a < 40, 900);
  const deal = PublicKey.findProgramAddressSync([Buffer.from("room-deal"), room.toBuffer()], program.programId)[0];
  await send(
    borrower,
    await program.methods
      .acceptLoan(1)
      .accountsPartial({
        borrower: borrower.kp.publicKey,
        anchor,
        terms: loanTermsPda(anchor),
        borrowerUsdc: ata(borrower.kp.publicKey, USDC),
        borrowerWsol: ata(borrower.kp.publicKey, WSOL),
        loanUsdc: ata(anchor, USDC),
        loanWsol: ata(anchor, WSOL),
        lenderUsdc: ata(lender.kp.publicKey, USDC),
        priceUpdate: PYTH,
        deal,
        dealPermission: permissionPdaFromAccount(deal),
        vault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        permissionProgram: PERMISSION_PROGRAM_ID,
      })
      .instruction(),
  );

  // Schedule the watch. Anyone may; the borrower does it here.
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from("liq-pool")], program.programId);
  const quote = PublicKey.findProgramAddressSync([Buffer.from("quote"), anchor.toBuffer()], program.programId)[0];
  const crank = PublicKey.findProgramAddressSync([Buffer.from("crank"), anchor.toBuffer(), loanId], HYDRA_EPHEMERAL)[0];
  const scheduled = await send(
    borrower,
    await program.methods
      .scheduleWatch()
      .accountsPartial({
        anchor,
        terms: loanTermsPda(anchor),
        quote,
        pool,
        priceUpdate: PYTH,
        crank,
        vault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        hydraProgram: HYDRA_EPHEMERAL,
      })
      .instruction(),
  );
  expect("watch-scheduled", !!(await crankerEr.getAccountInfo(crank)), { crank: crank.toBase58(), scheduled });
  expect("cranker-cannot-read-loan", (await crankerEr.getAccountInfo(loanTermsPda(anchor))) === null, "terms hidden from cranker");

  // Run the cranker until the loan settles. No one calls claim.
  const expiry = decodeLoanTerms((await lender.er.getAccountInfo(loanTermsPda(anchor)))!.data).expiryTs;
  const runs: unknown[] = [];
  let status = "active";
  for (let i = 0; i < 40 && status === "active"; i++) {
    const r = await runCranker(crankerEr, cranker);
    runs.push({ t: Math.floor(Date.now() / 1000) - expiry, due: r.due, results: r.results.map((x) => x.error ?? "ok") });
    status = decodeLoanTerms((await lender.er.getAccountInfo(loanTermsPda(anchor)))!.data).status;
    if (status === "active") await sleep(8000);
  }
  checks["cranker-runs"] = runs.slice(-5);
  expect("expiry-settled-by-cranker", status === "expired" && (await privateBalance(lender, WSOL)) === collateral, {
    status,
    lenderWsol: (await privateBalance(lender, WSOL))?.toString(),
  });
  const again = await runCranker(crankerEr, cranker);
  expect("retry-after-settlement-harmless", (await privateBalance(lender, WSOL)) === collateral, { due: again.due });

  await cashOut(lender, [USDC, WSOL]);
  await cashOut(borrower, [USDC, WSOL]);
  const st = fail.length === 0 ? "PASS" : "FAIL";
  recordGate("12.1", { status: st, date: new Date().toISOString().slice(0, 10), loan: anchor.toBase58(), crank: crank.toBase58(), failed: fail, checks });
  console.log(`\nStory 12.1 (live expiry): ${st}`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
