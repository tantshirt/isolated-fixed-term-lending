// Story 10.1 on the Devnet TEE: a complete private loan.
// Loan A: propose, edit (revision 2), stale fund rejected, fund, accept, repay,
//         second repay rejected, claim after repay is a no-op.
// Loan B: fund then cancel; acceptance after cancel rejected.
// Loan C: 60-second term; repay after the deadline rejected; an outsider claims
//         the collateral for the lender; a second claim is a no-op.
// Exact private balances are checked at the end.
// Run: npx tsx scripts/private/loan.ts
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
import { collateralValueUsdc, debt as debtOf } from "../../../app/lib/loan-math";
import { ESPL_PROGRAM_ID, ata, eataPda } from "../../../app/lib/private/espl";
import { decodeLoanTerms, loanAnchorPda, loanTermsPda } from "../../../app/lib/private/loan-codec";
import { ROLE, roomAnchorPda, roomStatePda, roomThreadPda } from "../../../app/lib/private/room-codec";
import { refreshPyth } from "../../../app/scripts/pyth-refresh";
import { recordGate } from "../../spikes/lib/evidence";
import { authority as funder, base, program, sleep, teeConnection, waitFor } from "../../spikes/lib/custody";
import { USDC, WSOL, cashOut, makePrivate, newParty, privateBalance, type Party } from "./lib/parties";

const PYTH = PublicKey.findProgramAddressSync(
  [Buffer.from([0, 0]), Buffer.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex")],
  new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT"),
)[0];
const CODES: Record<string, number> = { WrongStatus: 6025, StaleRevision: 6026, LoanExpired: 6029, LoanNotExpired: 6030 };

const checks: Record<string, unknown> = {};
const fail: string[] = [];
const expect = (name: string, ok: boolean, detail: unknown) => {
  checks[name] = { ok, detail };
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`, typeof detail === "string" ? detail.slice(0, 160) : detail);
  if (!ok) fail.push(name);
};

async function send(p: Party, ix: TransactionInstruction): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const tx = new Transaction().add(ix);
    tx.feePayer = p.kp.publicKey;
    tx.recentBlockhash = (await p.er.getLatestBlockhash()).blockhash;
    tx.sign(p.kp);
    let sig: string;
    try {
      sig = await p.er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    } catch (e) {
      const keys = ix.keys.map((k) => `${k.pubkey.toBase58().slice(0, 6)}${k.isWritable ? "w" : ""}${k.isSigner ? "s" : ""}`).join(" ");
      throw new Error(`send by ${p.name} rejected (${keys}): ${String(e).slice(0, 120)}`);
    }
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

async function rejects(code: string, f: () => Promise<unknown>) {
  try {
    await f();
    return { ok: false, detail: "unexpectedly succeeded" };
  } catch (e) {
    const msg = String(e);
    return { ok: msg.includes(`"Custom":${CODES[code]}`), detail: msg.slice(0, 160) };
  }
}

/** Accept and liquidate need a price under 60 s old inside the TEE. */
async function freshPrice(p: Party) {
  const age = async () => {
    const d = (await p.er.getAccountInfo(PYTH))!.data;
    return Math.floor(Date.now() / 1000) - Number(d.readBigInt64LE(8 + 32 + (d[40] === 0 ? 2 : 1) + 32 + 20));
  };
  if ((await age()) < 40) return;
  // Posting our own update needs a Hermes API key; without one, wait for the
  // sponsored Devnet feed's next refresh.
  if (process.env.PYTH_HERMES_API_KEY) await refreshPyth(base, funder);
  await waitFor("fresh SOL/USD price in the TEE", age, (a) => a < 40, 900);
}

async function solUsd() {
  const d = (await base.getAccountInfo(PYTH))!.data;
  const off = 8 + 32 + (d[40] === 0 ? 2 : 1) + 32;
  return { price: d.readBigInt64LE(off), conf: d.readBigUInt64LE(off + 8), exponent: d.readInt32LE(off + 16) };
}

async function main() {
  // Parties.
  const lender = await newParty("lender", 150_000_000, 250_000n);
  const borrower = await newParty("borrower", 150_000_000, 20_000n);
  const outsider: Party = { kp: Keypair.generate(), er: await teeConnection(Keypair.generate()), name: "outsider" };
  outsider.er = await teeConnection(outsider.kp);

  // Collateral at roughly 50% LTV for a 0.1 USDC loan at today's price.
  const { price, conf, exponent } = await solUsd();
  const principal = 100_000n;
  const target = (debtOf(principal, 500) * 10_000n) / 5_000n;
  let collateral = (target * 10n ** BigInt(3 - exponent)) / (price - conf) + 1n;
  while (collateralValueUsdc(collateral, price, conf, exponent) < target) collateral += 1n;
  checks["collateral"] = { lamports: collateral.toString(), price: price.toString(), exponent };

  await makePrivate(lender, USDC, 250_000n);
  await makePrivate(lender, WSOL, 0n);
  await makePrivate(borrower, USDC, 20_000n);
  await makePrivate(borrower, WSOL, collateral * 2n);

  // Room: lender owns it, borrower is invited as borrower.
  const roomId = randomBytes(32);
  const room = roomAnchorPda(roomId);
  const roomState = roomStatePda(room);
  const roomThread = roomThreadPda(room);
  await sendAndConfirmTransaction(
    base,
    new Transaction().add(
      await program.methods.openRoom([...roomId]).accountsPartial({ creator: lender.kp.publicKey, anchor: room }).instruction(),
      await program.methods.delegateRoom([...roomId]).accountsPartial({ creator: lender.kp.publicKey, anchor: room }).instruction(),
    ),
    [lender.kp],
  );
  await waitFor("room in ER", () => lender.er.getAccountInfo(room), () => true);
  const roomAccounts = {
    anchor: room,
    state: roomState,
    statePermission: permissionPdaFromAccount(roomState),
    thread: roomThread,
    threadPermission: permissionPdaFromAccount(roomThread),
    vault: EPHEMERAL_VAULT_ID,
    magicProgram: MAGIC_PROGRAM_ID,
    permissionProgram: PERMISSION_PROGRAM_ID,
  };
  await send(lender, await program.methods.initRoom().accountsPartial({ owner: lender.kp.publicKey, ...roomAccounts }).instruction());
  await send(
    lender,
    await program.methods.inviteMember(borrower.kp.publicKey, ROLE.borrower).accountsPartial({ owner: lender.kp.publicKey, ...roomAccounts }).instruction(),
  );

  // Loan helpers.
  const terms = (overrides: Partial<{ interestBps: number; durationSeconds: number }> = {}) => ({
    borrower: borrower.kp.publicKey,
    principal: new BN(principal.toString()),
    interestBps: overrides.interestBps ?? 500,
    durationSeconds: new BN(overrides.durationSeconds ?? 3600),
    collateralAmount: new BN(collateral.toString()),
    maxLtvBps: 7000,
    liquidationLtvBps: 8000,
  });
  async function createLoan() {
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
    return anchor;
  }
  const propose = async (anchor: PublicKey, args = terms()) =>
    send(
      lender,
      await program.methods
        .proposeTerms(args)
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
  const lenderMoves = (anchor: PublicKey) => ({
    lender: lender.kp.publicKey,
    anchor,
    terms: loanTermsPda(anchor),
    lenderUsdc: ata(lender.kp.publicKey, USDC),
    loanUsdc: ata(anchor, USDC),
  });
  const borrowerMoves = (anchor: PublicKey) => ({
    borrower: borrower.kp.publicKey,
    anchor,
    terms: loanTermsPda(anchor),
    borrowerUsdc: ata(borrower.kp.publicKey, USDC),
    borrowerWsol: ata(borrower.kp.publicKey, WSOL),
    loanUsdc: ata(anchor, USDC),
    loanWsol: ata(anchor, WSOL),
    lenderUsdc: ata(lender.kp.publicKey, USDC),
    priceUpdate: PYTH,
  });
  const claimIx = (anchor: PublicKey) =>
    program.methods
      .claimExpired()
      .accountsPartial({ anchor, terms: loanTermsPda(anchor), loanWsol: ata(anchor, WSOL), lenderWsol: ata(lender.kp.publicKey, WSOL) })
      .instruction();
  const readTerms = async (p: Party, anchor: PublicKey) => {
    const i = await p.er.getAccountInfo(loanTermsPda(anchor));
    return i ? decodeLoanTerms(i.data) : null;
  };

  // ---- Loan A: revisions and repayment.
  const A = await createLoan();
  await propose(A);
  const seenByBorrower = await readTerms(borrower, A);
  expect("borrower-reads-terms", seenByBorrower?.principal === principal && seenByBorrower.revision === 1, { revision: seenByBorrower?.revision });
  expect("outsider-cannot-read-terms", (await readTerms(outsider, A)) === null, "terms hidden");
  await send(lender, await program.methods.editTerms(terms({ interestBps: 400 })).accountsPartial({ lender: lender.kp.publicKey, anchor: A, terms: loanTermsPda(A) }).instruction());
  const stale = await rejects("StaleRevision", async () => send(lender, await program.methods.fundLoan(1).accountsPartial(lenderMoves(A)).instruction()));
  expect("funding-an-old-revision-rejected", stale.ok, stale.detail);
  await send(lender, await program.methods.fundLoan(2).accountsPartial(lenderMoves(A)).instruction());
  await freshPrice(borrower);
  await send(borrower, await program.methods.acceptLoan(2).accountsPartial(borrowerMoves(A)).instruction());
  const active = await readTerms(lender, A);
  expect("accepted-on-same-revision", active?.status === "active" && active.fundedRevision === 2 && active.acceptedRevision === 2, {
    status: active?.status,
    expiry: active?.expiryTs,
  });
  await send(borrower, await program.methods.repayLoan().accountsPartial(borrowerMoves(A)).instruction());
  const twice = await rejects("WrongStatus", async () => send(borrower, await program.methods.repayLoan().accountsPartial(borrowerMoves(A)).instruction()));
  expect("second-repay-rejected", twice.ok, twice.detail);
  await send(outsider, await claimIx(A));
  expect("claim-after-repay-is-noop", (await readTerms(lender, A))?.status === "repaid", "still repaid");

  // ---- Loan B: cancel.
  const B = await createLoan();
  await propose(B);
  await send(lender, await program.methods.fundLoan(1).accountsPartial(lenderMoves(B)).instruction());
  await send(lender, await program.methods.cancelLoan().accountsPartial(lenderMoves(B)).instruction());
  const late = await rejects("WrongStatus", async () => send(borrower, await program.methods.acceptLoan(1).accountsPartial(borrowerMoves(B)).instruction()));
  expect("accept-after-cancel-rejected", late.ok, late.detail);

  // ---- Loan C: expiry.
  const C = await createLoan();
  await propose(C, terms({ durationSeconds: 60 }));
  await send(lender, await program.methods.fundLoan(1).accountsPartial(lenderMoves(C)).instruction());
  await freshPrice(borrower);
  await send(borrower, await program.methods.acceptLoan(1).accountsPartial(borrowerMoves(C)).instruction());
  const tooEarly = await rejects("LoanNotExpired", async () => send(outsider, await claimIx(C)));
  checks["claim-before-deadline"] = tooEarly;
  const expiry = (await readTerms(lender, C))!.expiryTs;
  while (Date.now() / 1000 < expiry + 3) await sleep(2000);
  const afterDeadline = await rejects("LoanExpired", async () => send(borrower, await program.methods.repayLoan().accountsPartial(borrowerMoves(C)).instruction()));
  expect("repay-after-deadline-rejected", afterDeadline.ok, afterDeadline.detail);
  await send(outsider, await claimIx(C));
  await send(outsider, await claimIx(C));
  expect("outsider-claims-for-lender-once", (await readTerms(lender, C))?.status === "expired", "expired; second claim no-op");

  // ---- Exact balances.
  const interestA = debtOf(principal, 400) - principal;
  const want = {
    lenderUsdc: 250_000n + interestA - principal, // A repaid with interest, B refunded, C principal went to the borrower
    lenderWsol: collateral, // C collateral
    borrowerUsdc: 20_000n - interestA + principal, // paid A's interest, kept C's principal
    borrowerWsol: collateral, // got A's back, lost C's
  };
  const got = {
    lenderUsdc: await privateBalance(lender, USDC),
    lenderWsol: await privateBalance(lender, WSOL),
    borrowerUsdc: await privateBalance(borrower, USDC),
    borrowerWsol: await privateBalance(borrower, WSOL),
  };
  expect(
    "exact-private-balances",
    Object.entries(want).every(([k, v]) => got[k as keyof typeof got] === v),
    Object.fromEntries(Object.keys(want).map((k) => [k, `${got[k as keyof typeof got]} / ${want[k as keyof typeof want]}`])),
  );
  expect(
    "terms-never-on-solana",
    (await Promise.all([A, B, C].map((l) => base.getAccountInfo(loanTermsPda(l))))).every((i) => i === null),
    "LoanTerms absent on base",
  );

  await cashOut(lender, [USDC, WSOL]);
  await cashOut(borrower, [USDC, WSOL]);

  const status = fail.length === 0 ? "PASS" : "FAIL";
  recordGate("10.1", {
    status,
    date: new Date().toISOString().slice(0, 10),
    loans: { A: A.toBase58(), B: B.toBase58(), C: C.toBase58() },
    room: room.toBase58(),
    failed: fail,
    checks,
  });
  console.log(`\nStory 10.1: ${status}`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
