// Story 9.3 on the Devnet TEE: a wallet's own private USDC balance.
// Uses a fresh test wallet funded from the main wallet, so existing eATAs of
// the main wallet are left alone, and returns the funds at the end.
// Make the eATA private, deposit and delegate, read inside the TEE as owner vs
// outsider, then undelegate and withdraw to an exact round trip. Every base
// transaction passes the reviewed-transaction validator before signing.
// Run: npx tsx scripts/private/balances.ts
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction } from "@solana/spl-token";
import {
  ESPL_PROGRAM_ID,
  FLAG,
  ata,
  createEataPermission,
  delegate,
  delegateEataPermission,
  deposit,
  eataAmount,
  eataPda,
  initializeEata,
  permissionPda,
  undelegate,
  withdraw,
} from "../../../app/lib/private/espl";
import { assertDevnet, validateTransaction, type Review } from "../../../app/lib/private/tx-validator";
import { recordGate } from "../../spikes/lib/evidence";
import { authority as funder, base, sleep, teeConnection, waitFor } from "../../spikes/lib/custody";

const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const AMOUNT = 100_000n;
const owner = Keypair.generate();

async function balance(c: Connection, account: PublicKey): Promise<bigint | null> {
  try {
    return BigInt((await c.getTokenAccountBalance(account)).value.amount);
  } catch {
    return null;
  }
}

async function reviewedSend(tx: Transaction, review: Review) {
  tx.feePayer = owner.publicKey;
  validateTransaction(tx, review);
  return sendAndConfirmTransaction(base, tx, [owner]);
}

async function main() {
  const checks: Record<string, unknown> = {};
  const fail: string[] = [];
  const expect = (name: string, ok: boolean, detail: unknown) => {
    checks[name] = { ok, detail };
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail);
    if (!ok) fail.push(name);
  };
  await assertDevnet(base);
  // Fund the test wallet: SOL for fees and rent, and exactly AMOUNT of USDC.
  await sendAndConfirmTransaction(
    base,
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: owner.publicKey, lamports: 30_000_000 }),
      createAssociatedTokenAccountIdempotentInstruction(funder.publicKey, ata(owner.publicKey, USDC), owner.publicKey, USDC),
      createTransferInstruction(ata(funder.publicKey, USDC), ata(owner.publicKey, USDC), funder.publicKey, AMOUNT),
    ),
    [funder],
  );
  const er = await teeConnection(owner);
  const outsider = await teeConnection(Keypair.generate());

  const eata = eataPda(owner.publicKey, USDC);
  const walletAta = ata(owner.publicKey, USDC);
  const start = (await balance(base, walletAta)) ?? 0n;
  const sigs: Record<string, string> = {};

  // 1. Create the eATA and its owner-only permission once.
  const setup = new Transaction();
  if (!(await base.getAccountInfo(eata))) setup.add(initializeEata(owner.publicKey, USDC));
  if (!(await base.getAccountInfo(permissionPda(eata)))) {
    setup.add(createEataPermission(owner.publicKey, USDC, FLAG.txLogs | FLAG.txBalances | FLAG.txMessage));
  }
  if (setup.instructions.length) sigs.setup = await reviewedSend(setup, { feePayer: owner.publicKey });

  // 2. Deposit and delegate both the eATA and its permission.
  sigs.deposit = await reviewedSend(
    new Transaction().add(
      deposit(owner.publicKey, USDC, AMOUNT),
      delegateEataPermission(owner.publicKey, USDC),
      delegate(owner.publicKey, USDC),
    ),
    { feePayer: owner.publicKey, transfers: [{ kind: "deposit", owner: owner.publicKey, mint: USDC, amount: AMOUNT }] },
  );
  expect("wallet-debited-exactly", (await balance(base, walletAta)) === start - AMOUNT, { start: start.toString() });

  // 3. Inside the TEE: owner sees the balance, an outsider does not.
  const mine = await waitFor("private balance in ER", () => balance(er, walletAta), (v) => v >= AMOUNT, 60).catch(() => null);
  expect("owner-reads-private-balance", mine !== null && mine >= AMOUNT, { owner: mine?.toString() ?? null });
  const theirs = await balance(outsider, walletAta);
  expect("outsider-cannot-read-balance", theirs === null || theirs !== mine, { outsider: theirs?.toString() ?? null });

  // 4. Undelegate inside the TEE, then withdraw exactly what was deposited.
  const tx = new Transaction().add(undelegate(owner.publicKey, USDC));
  tx.feePayer = owner.publicKey;
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  tx.sign(owner);
  sigs.undelegate = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await er.confirmTransaction(sigs.undelegate, "confirmed");
  expect("undelegate-in-er", res.value.err === null, res.value.err);
  const settled = await waitFor(
    "eATA back on base",
    () => base.getAccountInfo(eata),
    (i) => i.owner.equals(ESPL_PROGRAM_ID),
    120,
  );
  const committed = eataAmount(settled.data);
  sigs.withdraw = await reviewedSend(new Transaction().add(withdraw(owner.publicKey, USDC, committed)), {
    feePayer: owner.publicKey,
    transfers: [{ kind: "withdraw", owner: owner.publicKey, mint: USDC, amount: committed, destination: walletAta }],
  });
  await sleep(1000);
  const end = await balance(base, walletAta);
  expect("exact-round-trip", end === start && committed === AMOUNT, { start: start.toString(), end: end?.toString(), committed: committed.toString() });

  // 5. The validator refuses a withdrawal to a destination the user did not review.
  let refused = false;
  try {
    validateTransaction(Object.assign(new Transaction().add(withdraw(owner.publicKey, USDC, 1n)), { feePayer: owner.publicKey }), {
      feePayer: owner.publicKey,
      transfers: [{ kind: "withdraw", owner: owner.publicKey, mint: USDC, amount: 1n, destination: ata(Keypair.generate().publicKey, USDC) }],
    });
  } catch {
    refused = true;
  }
  expect("validator-refuses-unreviewed-destination", refused, "checked before signing");

  // Return the test funds.
  await sendAndConfirmTransaction(
    base,
    new Transaction().add(
      createTransferInstruction(walletAta, ata(funder.publicKey, USDC), owner.publicKey, (await balance(base, walletAta)) ?? 0n),
    ),
    [owner],
  );
  const left = await base.getBalance(owner.publicKey);
  await sendAndConfirmTransaction(
    base,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: funder.publicKey, lamports: left - 10_000 })),
    [owner],
  ).catch(() => undefined);

  const status = fail.length === 0 ? "PASS" : "FAIL";
  recordGate("9.3", { status, date: new Date().toISOString().slice(0, 10), eata: eata.toBase58(), signatures: sigs, failed: fail, checks });
  console.log(`\nStory 9.3: ${status}`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
