// Stories 22.1 and 22.2 on the Devnet TEE, against private_loan_v2.
//
// - Config: the upgrade authority writes separated authorities; a non-authority cannot.
// - Room: the owner gives themselves only Viewer, so proposing as lender fails (no owner bypass).
// - Two loans in one room for two borrowing requests; room indexes 0 and 1, both registry
//   entries readable by members and not by an outsider.
// - A competing proposal for request 0 cannot be accepted once request 0 has a deal.
// - Loan A: partial repay (ledger moves, deadline does not), top-up, full repay returns all wSOL.
// - Loan B stays active with a 60-second term and 24-hour grace: an overdue fixture for the watch.
// - Desk (Stories 23.1, 24.1): an admin-only administrator cannot originate or read loans; a desk
//   lender's loan above the policy ceiling is rejected; a compliant desk loan pins the policy, the
//   borrower accepts the shown auditor audience, and the auditor can read the terms afterwards.
// Results are appended to docs/magicblock-evidence.json under "v2".
// Run: npx tsx scripts/private/v2-rooms.ts
import { AnchorProvider, BN, Program, Wallet, type Idl } from "@coral-xyz/anchor";
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
import { createHash } from "node:crypto";
import { collateralValueUsdc } from "../../../app/lib/loan-math";
import { maxExposure, EarlyRepayment } from "../../../app/lib/loan-math-v2";
import { ESPL_PROGRAM_ID, ata, eataPda } from "../../../app/lib/private/espl";
import { refreshPyth } from "../../../app/scripts/pyth-refresh";
import { recordGate } from "../../spikes/lib/evidence";
import { authority as funder, base, sleep, teeConnection, waitFor } from "../../spikes/lib/custody";
import { USDC, WSOL, cashOut, makePrivate, newParty, privateBalance, type Party } from "./lib/parties";

const idl = JSON.parse(readFileSync(new URL("../../target/idl/private_loan_v2.json", import.meta.url), "utf8")) as Idl;
const program: any = new Program(idl, new AnchorProvider(base, new Wallet(funder), { commitment: "confirmed" }));
const ID: PublicKey = program.programId;
const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), ID)[0];
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const ROLE = { borrower: 1, lender: 2, viewer: 4 };
const PYTH = PublicKey.findProgramAddressSync(
  [Buffer.from([0, 0]), Buffer.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex")],
  new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT"),
)[0];
const errorCode = (name: string) => 6000 + (idl.errors ?? []).findIndex((e) => e.name.toLowerCase() === name.toLowerCase());

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

async function rejects(code: string, f: () => Promise<unknown>) {
  try {
    await f();
    return { ok: false, detail: "unexpectedly succeeded" };
  } catch (e) {
    const msg = String(e);
    return { ok: msg.includes(`"Custom":${errorCode(code)}`), detail: msg.slice(0, 160) };
  }
}

async function freshPrice(p: Party) {
  const age = async () => {
    const d = (await p.er.getAccountInfo(PYTH))!.data;
    return Math.floor(Date.now() / 1000) - Number(d.readBigInt64LE(8 + 32 + (d[40] === 0 ? 2 : 1) + 32 + 20));
  };
  if ((await age()) < 40) return;
  if (process.env.PYTH_HERMES_API_KEY) await refreshPyth(base, funder);
  await waitFor("fresh SOL/USD price in the TEE", age, (a) => a < 40, 900);
}

async function solUsd() {
  const d = (await base.getAccountInfo(PYTH))!.data;
  const off = 8 + 32 + (d[40] === 0 ? 2 : 1) + 32;
  return { price: d.readBigInt64LE(off), conf: d.readBigUInt64LE(off + 8), exponent: d.readInt32LE(off + 16) };
}

/** Decodes the V2 `LoanTerms` record with the IDL-free layout the program writes (borsh). */
function readTermsFields(d: Buffer) {
  let o = 0;
  const u8 = () => d[o++];
  const key = () => { const k = new PublicKey(d.subarray(o, o + 32)); o += 32; return k; };
  const r32 = () => { const v = d.readUInt32LE(o); o += 4; return v; };
  const r64 = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
  const i64 = () => { const v = d.readBigInt64LE(o); o += 8; return Number(v); };
  const r16 = () => { const v = d.readUInt16LE(o); o += 2; return v; };
  const version = u8(), originLender = key(), currentLender = key(), borrower = key(), roomIndex = r32(), requestIndex = r32();
  const principal = r64(), interestBps = r16(), duration = i64(), early = u8(), minInterest = r16(), grace = i64(), lateFee = r16(), ceiling = r16();
  const collateralRequired = r64(), collateralLocked = r64(), maxLtv = r16(), liqLtv = r16(), revision = r32(), funded = r32(), accepted = r32(), status = u8(), startTs = i64();
  const outstanding = r64(), accrued = r64(), paid = r64();
  return { version, originLender, currentLender, borrower, roomIndex, requestIndex, principal, interestBps, duration, early, minInterest, grace, lateFee, ceiling, collateralRequired, collateralLocked, maxLtv, liqLtv, revision, funded, accepted, status, startTs, outstanding, accrued, paid };
}

async function main() {
  // ---- Config, once per deployment, by the upgrade authority.
  const config = pda(Buffer.from("config"));
  if (!(await base.getAccountInfo(config))) {
    const k = () => Keypair.generate().publicKey;
    const authorities = {
      governance: new PublicKey("8MpmERed9K14R68F371YJtGVk6mQgNZoQeU3asNPs5mt"),
      aiAdmin: funder.publicKey,
      aiWorker: new PublicKey("8wohrpifR962YAwTQjcQjtejSfxbXWeRNGW5B5q16wLq"),
      liquidationPoolAdmin: k(),
      credentialIssuer: k(),
      keeper: new PublicKey("Da8h3MkHJPFnZEcNRQzkPPe94AGj6zGmDJrGtyuqUoH7"),
    };
    const programData = PublicKey.findProgramAddressSync([ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
    const sig = await program.methods.initConfig(authorities).accountsPartial({ payer: funder.publicKey, config, program: ID, programData }).rpc();
    expect("config-initialized-by-upgrade-authority", true, sig);
  }

  const lender = await newParty("lender", 150_000_000, 300_000n);
  const lender2 = await newParty("lender2", 120_000_000, 200_000n);
  const borrower = await newParty("borrower", 150_000_000, 20_000n);
  const owner = await newParty("owner", 120_000_000, 0n);
  const outsider: Party = { kp: Keypair.generate(), er: await teeConnection(Keypair.generate()), name: "outsider" };
  outsider.er = await teeConnection(outsider.kp);

  const { price, conf, exponent } = await solUsd();
  const principal = 100_000n;
  const rules = { earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 2_500, graceSeconds: 86_400, lateFeeBps: 100, annualCeilingBps: 40_000 };
  const exposure = maxExposure({ principal, interestBps: 100, duration: 3_600, startTs: 0, ...rules });
  const target = (exposure * 10_000n) / 5_000n;
  let collateral = (target * 10n ** BigInt(3 - exponent)) / (price - conf) + 1n;
  while (collateralValueUsdc(collateral, price, conf, exponent) < target) collateral += 1n;
  await makePrivate(lender, USDC, 300_000n);
  await makePrivate(lender, WSOL, 0n);
  await makePrivate(lender2, USDC, 200_000n);
  await makePrivate(borrower, USDC, 20_000n);
  await makePrivate(borrower, WSOL, collateral * 4n);

  // ---- Room owned by a viewer-only owner.
  const roomId = randomBytes(32);
  const room = pda(Buffer.from("room"), owner.kp.publicKey.toBuffer(), roomId);
  const roomState = pda(Buffer.from("room-state"), room.toBuffer());
  const roomThread = pda(Buffer.from("room-thread"), room.toBuffer());
  await sendAndConfirmTransaction(
    base,
    new Transaction().add(
      await program.methods.openRoom([...roomId]).accountsPartial({ creator: owner.kp.publicKey, anchor: room }).instruction(),
      await program.methods.delegateRoom([...roomId]).accountsPartial({ creator: owner.kp.publicKey, anchor: room }).instruction(),
    ),
    [owner.kp],
  );
  await waitFor("room in ER", () => owner.er.getAccountInfo(room), () => true);
  const roomAccounts = {
    anchor: room, state: roomState, statePermission: permissionPdaFromAccount(roomState), thread: roomThread,
    threadPermission: permissionPdaFromAccount(roomThread), vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID, permissionProgram: PERMISSION_PROGRAM_ID,
  };
  await send(owner, await program.methods.initRoom(ROLE.viewer).accountsPartial({ owner: owner.kp.publicKey, ...roomAccounts }).instruction());
  for (const [p, role] of [[lender, ROLE.lender], [lender2, ROLE.lender], [borrower, ROLE.borrower]] as const) {
    await send(owner, await program.methods.inviteMember(p.kp.publicKey, role).accountsPartial({ owner: owner.kp.publicKey, ...roomAccounts }).instruction());
  }

  // ---- Loans.
  const termsArgs = (requestIndex: number, durationSeconds = 3_600) => ({
    borrower: borrower.kp.publicKey, requestIndex, principal: new BN(principal.toString()), interestBps: 100, durationSeconds: new BN(durationSeconds),
    earlyRepayment: rules.earlyRepayment, minInterestBps: rules.minInterestBps, graceSeconds: new BN(rules.graceSeconds), lateFeeBps: rules.lateFeeBps,
    annualCeilingBps: rules.annualCeilingBps, collateralAmount: new BN(collateral.toString()), maxLtvBps: 7_000, liquidationLtvBps: 8_000,
  });
  async function createLoan(p: Party) {
    const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
    const anchor = pda(Buffer.from("loan"), p.kp.publicKey.toBuffer(), u64(nonce));
    const ue = eataPda(anchor, USDC);
    const we = eataPda(anchor, WSOL);
    await sendAndConfirmTransaction(
      base,
      new Transaction().add(
        await program.methods.createLoan(new BN(nonce.toString())).accountsPartial({
          lender: p.kp.publicKey, anchor, room, usdcMint: USDC, wsolMint: WSOL, usdcEata: ue, wsolEata: we,
          usdcBuffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(ue, ESPL_PROGRAM_ID), usdcRecord: delegationRecordPdaFromDelegatedAccount(ue), usdcMetadata: delegationMetadataPdaFromDelegatedAccount(ue),
          wsolBuffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(we, ESPL_PROGRAM_ID), wsolRecord: delegationRecordPdaFromDelegatedAccount(we), wsolMetadata: delegationMetadataPdaFromDelegatedAccount(we),
          esplProgram: ESPL_PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM_ID,
        }).instruction(),
        await program.methods.delegateLoan(new BN(nonce.toString())).accountsPartial({ lender: p.kp.publicKey, anchor }).instruction(),
      ),
      [p.kp],
    );
    await waitFor("loan in ER", () => p.er.getAccountInfo(anchor), () => true);
    return anchor;
  }
  const termsPda = (anchor: PublicKey) => pda(Buffer.from("loan-terms"), anchor.toBuffer());
  const nextIndex = async () => (await owner.er.getAccountInfo(roomState))!.data.readUInt32LE(1 + 32 + 8);
  const propose = async (p: Party, anchor: PublicKey, args: ReturnType<typeof termsArgs>) => {
    const index = await nextIndex();
    const registry = pda(Buffer.from("room-loan"), room.toBuffer(), u32(index));
    await send(p, await program.methods.proposeTerms(args).accountsPartial({
      lender: p.kp.publicKey, anchor, room, roomState, registry, registryPermission: permissionPdaFromAccount(registry), terms: termsPda(anchor),
      termsPermission: permissionPdaFromAccount(termsPda(anchor)), vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID, permissionProgram: PERMISSION_PROGRAM_ID,
    }).instruction());
    return { index, registry };
  };
  const lenderMoves = (p: Party, anchor: PublicKey) => ({ lender: p.kp.publicKey, anchor, terms: termsPda(anchor), lenderUsdc: ata(p.kp.publicKey, USDC), loanUsdc: ata(anchor, USDC) });
  const borrowerMoves = (anchor: PublicKey, lenderKey: PublicKey, requestIndex: number) => {
    const deal = pda(Buffer.from("room-deal"), room.toBuffer(), u32(requestIndex));
    return {
      borrower: borrower.kp.publicKey, anchor, terms: termsPda(anchor), borrowerUsdc: ata(borrower.kp.publicKey, USDC), borrowerWsol: ata(borrower.kp.publicKey, WSOL),
      loanUsdc: ata(anchor, USDC), loanWsol: ata(anchor, WSOL), lenderUsdc: ata(lenderKey, USDC), priceUpdate: PYTH, deal, dealPermission: permissionPdaFromAccount(deal),
      vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID, permissionProgram: PERMISSION_PROGRAM_ID, termsPermission: null, deskPolicy: null,
    };
  };
  const NO_AUDITORS = Array(32).fill(0);
  const terms = async (p: Party, anchor: PublicKey) => {
    const i = await p.er.getAccountInfo(termsPda(anchor));
    return i ? readTermsFields(i.data as Buffer) : null;
  };

  // No owner bypass: the viewer-only owner cannot propose as lender.
  const ownersLoan = await createLoan(owner);
  const bypass = await rejects("NotLender", () => propose(owner, ownersLoan, termsArgs(0)));
  expect("owner-has-no-lender-bypass", bypass.ok, bypass.detail);

  const A = await createLoan(lender);
  const a = await propose(lender, A, termsArgs(0));
  const B = await createLoan(lender2);
  const b = await propose(lender2, B, termsArgs(1, 60));
  const C = await createLoan(lender2);
  await propose(lender2, C, termsArgs(0));
  expect("room-indexes-are-sequential", a.index === 0 && b.index === 1, { a: a.index, b: b.index });
  const registryA = await borrower.er.getAccountInfo(a.registry);
  expect("members-read-the-room-registry", !!registryA && new PublicKey(registryA.data.subarray(0, 32)).equals(A), a.registry.toBase58());
  expect("outsiders-cannot-read-the-registry", (await outsider.er.getAccountInfo(a.registry)) === null, "hidden");

  await send(lender, await program.methods.fundLoan(1).accountsPartial(lenderMoves(lender, A)).instruction());
  await send(lender2, await program.methods.fundLoan(1).accountsPartial(lenderMoves(lender2, B)).instruction());
  await send(lender2, await program.methods.fundLoan(1).accountsPartial(lenderMoves(lender2, C)).instruction());
  await freshPrice(borrower);
  await send(borrower, await program.methods.acceptLoan(1, NO_AUDITORS).accountsPartial(borrowerMoves(A, lender.kp.publicKey, 0)).instruction());
  await freshPrice(borrower);
  await send(borrower, await program.methods.acceptLoan(1, NO_AUDITORS).accountsPartial(borrowerMoves(B, lender2.kp.publicKey, 1)).instruction());
  const both = [await terms(borrower, A), await terms(borrower, B)];
  expect("two-loans-active-in-one-room", both.every((t) => t?.status === 2), both.map((t) => t?.status));
  await freshPrice(borrower);
  const competing = await rejects("CompetingOfferAccepted", async () => send(borrower, await program.methods.acceptLoan(1, NO_AUDITORS).accountsPartial(borrowerMoves(C, lender2.kp.publicKey, 0)).instruction()));
  expect("one-accepted-proposal-per-request", competing.ok, competing.detail);
  await send(lender2, await program.methods.cancelLoan().accountsPartial(lenderMoves(lender2, C)).instruction());

  // Loan A: partial, top-up, full.
  const beforeDeadline = (await terms(lender, A))!;
  await send(borrower, await program.methods.repay(new BN(40_000)).accountsPartial(borrowerMoves(A, lender.kp.publicKey, 0)).instruction());
  const partial = (await terms(lender, A))!;
  expect("partial-repay-keeps-the-deadline", partial.status === 2 && partial.outstanding < principal && partial.startTs === beforeDeadline.startTs, {
    outstanding: partial.outstanding.toString(), paid: partial.paid.toString(),
  });
  await send(borrower, await program.methods.addCollateral(new BN(1_000_000)).accountsPartial(borrowerMoves(A, lender.kp.publicKey, 0)).instruction());
  expect("top-up-adds-collateral", (await terms(lender, A))!.collateralLocked === collateral + 1_000_000n, "locked");
  const borrowerWsol0 = await privateBalance(borrower, WSOL);
  await send(borrower, await program.methods.repay(new BN(1_000_000)).accountsPartial(borrowerMoves(A, lender.kp.publicKey, 0)).instruction());
  const closed = (await terms(lender, A))!;
  expect("full-repay-returns-all-collateral", closed.status === 3 && (await privateBalance(borrower, WSOL)) - borrowerWsol0 === collateral + 1_000_000n, { status: closed.status });
  expect("terms-never-on-solana", (await Promise.all([A, B, C].map((l) => base.getAccountInfo(termsPda(l))))).every((i) => i === null), "absent on base");

  // ---- Desk.
  const deskAdmin = owner;
  const auditor: Party = { kp: Keypair.generate(), er: await teeConnection(Keypair.generate()), name: "auditor" };
  auditor.er = await teeConnection(auditor.kp);
  const deskId = randomBytes(32);
  const desk = pda(Buffer.from("desk"), deskAdmin.kp.publicKey.toBuffer(), deskId);
  const deskState = pda(Buffer.from("desk-state"), desk.toBuffer());
  await sendAndConfirmTransaction(
    base,
    new Transaction().add(
      await program.methods.openDesk([...deskId]).accountsPartial({ creator: deskAdmin.kp.publicKey, anchor: desk }).instruction(),
      await program.methods.delegateDesk([...deskId]).accountsPartial({ creator: deskAdmin.kp.publicKey, anchor: desk }).instruction(),
    ),
    [deskAdmin.kp],
  );
  await waitFor("desk in ER", () => deskAdmin.er.getAccountInfo(desk), () => true);
  const deskAccounts = { anchor: desk, state: deskState, statePermission: permissionPdaFromAccount(deskState), vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID, permissionProgram: PERMISSION_PROGRAM_ID };
  await send(deskAdmin, await program.methods.initDesk(1).accountsPartial({ admin: deskAdmin.kp.publicKey, ...deskAccounts }).instruction());
  await send(deskAdmin, await program.methods.setDeskMember(lender2.kp.publicKey, 2).accountsPartial({ admin: deskAdmin.kp.publicKey, ...deskAccounts }).instruction());
  await send(deskAdmin, await program.methods.setDeskMember(auditor.kp.publicKey, 4).accountsPartial({ admin: deskAdmin.kp.publicKey, ...deskAccounts }).instruction());
  const policy1 = pda(Buffer.from("desk-policy"), desk.toBuffer(), u32(1));
  const auditors = [auditor.kp.publicKey, PublicKey.default, PublicKey.default, PublicKey.default];
  await send(deskAdmin, await program.methods.publishPolicy({
    minPrincipal: new BN(10_000), maxPrincipal: new BN(1_000_000), minDurationSeconds: new BN(60), maxDurationSeconds: new BN(30 * 86_400),
    maxAnnualCeilingBps: 40_000, maxInterestBps: 500, repaymentModes: 2, maxLtvBps: 7_000, maxLiquidationLtvBps: 8_000, minGraceSeconds: new BN(86_400),
    maxLateFeeBps: 100, auditorCount: 1, auditors,
  }).accountsPartial({ admin: deskAdmin.kp.publicKey, anchor: desk, state: deskState, policy: policy1, policyPermission: permissionPdaFromAccount(policy1), vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID, permissionProgram: PERMISSION_PROGRAM_ID }).instruction());
  const deskNext = async () => (await deskAdmin.er.getAccountInfo(deskState))!.data.readUInt32LE(1 + 8 + 4);
  const attach = async (p: Party, anchor: PublicKey) => {
    const book = pda(Buffer.from("desk-loan"), desk.toBuffer(), u32(await deskNext()));
    return send(p, await program.methods.attachDesk().accountsPartial({
      lender: p.kp.publicKey, anchor, terms: termsPda(anchor), desk, state: deskState, policy: policy1, bookEntry: book, bookPermission: permissionPdaFromAccount(book),
      vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID, permissionProgram: PERMISSION_PROGRAM_ID,
    }).instruction());
  };
  // The administrator is a room member only as viewer and not a desk lender: no origination.
  const adminLoan = await createLoan(lender);
  await propose(lender, adminLoan, termsArgs(2));
  const notDeskLender = await rejects("NotDeskLender", () => attach(lender, adminLoan));
  expect("non-desk-lender-cannot-originate-under-the-desk", notDeskLender.ok, notDeskLender.detail);
  const tooPricey = await createLoan(lender2);
  await propose(lender2, tooPricey, { ...termsArgs(3, 20 * 86_400), interestBps: 600, annualCeilingBps: 60_000 });
  const violation = await rejects("PolicyViolation", () => attach(lender2, tooPricey));
  expect("terms-outside-the-policy-rejected", violation.ok, violation.detail);
  const D = await createLoan(lender2);
  await propose(lender2, D, termsArgs(4));
  await attach(lender2, D);
  const pinned = await lender2.er.getAccountInfo(termsPda(D));
  const audHash = createHash("sha256").update(auditor.kp.publicKey.toBuffer()).digest();
  expect("desk-loan-pins-policy-and-audience", !!pinned && pinned.data.includes(audHash), "auditor hash recorded");
  await send(lender2, await program.methods.fundLoan(2).accountsPartial(lenderMoves(lender2, D)).instruction());
  const wrongAudience = await rejects("AuditorMismatch", async () => send(borrower, await program.methods.acceptLoan(2, NO_AUDITORS).accountsPartial({ ...borrowerMoves(D, lender2.kp.publicKey, 4), termsPermission: permissionPdaFromAccount(termsPda(D)), deskPolicy: policy1 }).instruction()));
  expect("acceptance-must-name-the-shown-audience", wrongAudience.ok, wrongAudience.detail);
  expect("auditor-cannot-read-before-acceptance", (await auditor.er.getAccountInfo(termsPda(D))) === null, "hidden");
  await freshPrice(borrower);
  await send(borrower, await program.methods.acceptLoan(2, [...audHash]).accountsPartial({ ...borrowerMoves(D, lender2.kp.publicKey, 4), termsPermission: permissionPdaFromAccount(termsPda(D)), deskPolicy: policy1 }).instruction());
  expect("auditor-reads-after-consent", (await auditor.er.getAccountInfo(termsPda(D))) !== null, "visible");
  expect("administrator-cannot-read-desk-loans", (await deskAdmin.er.getAccountInfo(termsPda(D))) === null, "admin has no read bypass");
  await send(borrower, await program.methods.removeLoanReader(auditor.kp.publicKey, [auditor.kp.publicKey]).accountsPartial({
    lender: borrower.kp.publicKey, borrower: null, anchor: D, terms: termsPda(D), termsPermission: permissionPdaFromAccount(termsPda(D)), vault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID, permissionProgram: PERMISSION_PROGRAM_ID,
  }).instruction());
  expect("removing-a-reader-ends-access", (await auditor.er.getAccountInfo(termsPda(D))) === null, "hidden again");

  await cashOut(lender, [USDC, WSOL]);
  await cashOut(owner, [USDC, WSOL]);
  const status = fail.length === 0 ? "PASS" : "FAIL";
  recordGate("v2-rooms", {
    status,
    date: new Date().toISOString().slice(0, 10),
    program: ID.toBase58(),
    room: room.toBase58(),
    loans: { A: A.toBase58(), B: B.toBase58(), C: C.toBase58(), D: D.toBase58() },
    desk: desk.toBase58(),
    overdueFixture: { loan: B.toBase58(), lender: lender2.kp.publicKey.toBase58(), borrower: borrower.kp.publicKey.toBase58(), note: "60-second term, 24-hour grace; parties kept in .local/parties for the watch evidence" },
    failed: fail,
    checks,
  });
  console.log(`\nV2 rooms: ${status}`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
