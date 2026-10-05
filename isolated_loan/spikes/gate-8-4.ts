// Gate 8.4: program-controlled eSPL custody for Devnet USDC and wSOL.
// Two custody PDAs per mint: A is funded, B starts empty. Inside the TEE, A pays
// B with a PDA-signed SPL transfer. Both return to base and withdraw.
// Run: npx tsx spikes/gate-8-4.ts   (recover with spikes/recover-custody.ts)
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import {
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection } from "@solana/web3.js";
import { randomBytes } from "node:crypto";
import { recordGate } from "./lib/evidence";
import {
  ESPL,
  ata,
  authority,
  base,
  custodyPda,
  eataPda,
  eataState,
  program,
  sendEr,
  teeConnection,
  undelegateIx,
  vaultPda,
  waitFor,
  withdrawIx,
} from "./lib/custody";

const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const checks: Record<string, unknown> = {};
const fail: string[] = [];
const expect = (name: string, ok: boolean, detail: unknown) => {
  checks[name] = { ok, detail };
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail);
  if (!ok) fail.push(name);
};

async function tokenAmount(c: Connection, account: PublicKey): Promise<bigint | null> {
  try {
    return BigInt((await c.getTokenAccountBalance(account)).value.amount);
  } catch {
    return null;
  }
}

async function runMint(label: string, mint: PublicKey, amount: bigint, er: Connection, outsiderEr: Connection) {
  const sigs: Record<string, string> = {};
  const vault = vaultPda(mint);
  const vaultInfo = await base.getAccountInfo(vault);
  expect(`${label}:global-vault-exists`, !!vaultInfo?.owner.equals(ESPL), { vault: vault.toBase58() });
  if (!vaultInfo) return { sigs };

  const authorityAta = ata(authority.publicKey, mint);
  const start = (await tokenAmount(base, authorityAta)) ?? 0n;
  const [idA, idB] = [randomBytes(32), randomBytes(32)];
  const [A, B] = [custodyPda(idA), custodyPda(idB)];
  const [eA, eB] = [eataPda(A, mint), eataPda(B, mint)];

  // 1. Create both custodies (PDA, ATA, eATA) in one base transaction.
  const create = (id: Buffer, custody: PublicKey) =>
    program.methods
      .createCustody([...id])
      .accountsPartial({ authority: authority.publicKey, custody, mint, eata: eataPda(custody, mint), esplProgram: ESPL })
      .instruction();
  sigs.create = await sendAndConfirmTransaction(base, new Transaction().add(await create(idA, A), await create(idB, B)), [authority]);

  // 2. Fund A, delegate both eATAs to the TEE, in one base transaction.
  const fund = (custody: PublicKey, amt: bigint) => {
    const eata = eataPda(custody, mint);
    return program.methods
      .fundAndDelegate(new BN(amt.toString()))
      .accountsPartial({
        authority: authority.publicKey,
        custody,
        mint,
        authorityAta,
        custodyAta: ata(custody, mint),
        eata,
        vault,
        vaultAta: ata(vault, mint),
        eataBuffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(eata, ESPL),
        eataRecord: delegationRecordPdaFromDelegatedAccount(eata),
        eataMetadata: delegationMetadataPdaFromDelegatedAccount(eata),
        esplProgram: ESPL,
        delegationProgram: DELEGATION_PROGRAM_ID,
      })
      .instruction();
  };
  sigs.fund = await sendAndConfirmTransaction(base, new Transaction().add(await fund(A, amount), await fund(B, 0n)), [authority]);
  const afterFund = await tokenAmount(base, authorityAta);
  const delegated = await Promise.all([eataState(base, eA), eataState(base, eB)]);
  expect(`${label}:deposit-and-delegate`, afterFund === start - amount && delegated.every((s) => s?.owner.equals(DELEGATION_PROGRAM_ID)) && delegated[0]?.amount === amount, {
    walletBefore: start.toString(),
    walletAfter: afterFund?.toString(),
    eataA: delegated[0]?.amount.toString(),
  });
  await waitFor(`${label} delegation visible in ER`, () => eataState(er, eA), (s) => s.amount === amount);

  // 3. PDA-signed transfer A -> B inside the TEE.
  const moved = (amount * 4n) / 10n;
  sigs.transfer = await sendEr(
    er,
    await program.methods
      .custodyTransfer(new BN(moved.toString()))
      .accountsPartial({ authority: authority.publicKey, custody: A, fromAta: ata(A, mint), toAta: ata(B, mint) })
      .instruction(),
  );

  // No wallet learns the real custody balance inside the TEE. The ER reports a
  // masked value (observed: 0) for the custody ATA, never the true amount.
  const truth = (amount - moved).toString();
  const views = {
    authority: (await tokenAmount(er, ata(A, mint)))?.toString() ?? null,
    outsider: (await tokenAmount(outsiderEr, ata(A, mint)))?.toString() ?? null,
    truth,
  };
  expect(`${label}:custody-balance-hidden-in-er`, views.authority !== truth && views.outsider !== truth, views);

  // 4. Undelegate both eATAs from inside the TEE; balances settle on base.
  sigs.undelegateA = await sendEr(er, await undelegateIx(A, mint));
  sigs.undelegateB = await sendEr(er, await undelegateIx(B, mint));
  const [sA, sB] = await Promise.all([
    waitFor(`${label} A on base`, () => eataState(base, eA), (s) => s.owner.equals(ESPL)),
    waitFor(`${label} B on base`, () => eataState(base, eB), (s) => s.owner.equals(ESPL)),
  ]);
  expect(`${label}:exact-after-er-transfer`, sA.amount === amount - moved && sB.amount === moved, {
    A: sA.amount.toString(),
    B: sB.amount.toString(),
    moved: moved.toString(),
  });

  // 5. Withdraw both. The wallet ends exactly where it started.
  sigs.withdraw = await sendAndConfirmTransaction(
    base,
    new Transaction().add(await withdrawIx(A, mint, sA.amount), await withdrawIx(B, mint, sB.amount)),
    [authority],
  );
  const end = await tokenAmount(base, authorityAta);
  const drained = await Promise.all([eataState(base, eA), eataState(base, eB)]);
  expect(`${label}:exact-round-trip`, end === start && drained.every((s) => s?.amount === 0n), {
    start: start.toString(),
    end: end?.toString(),
  });
  return { sigs, custodies: { A: A.toBase58(), B: B.toBase58() } };
}

async function main() {
  const er = await teeConnection(authority);
  const outsiderEr = await teeConnection(Keypair.generate());

  // Hold at least 0.01 wSOL for the wSOL run.
  const wsolAta = ata(authority.publicKey, NATIVE_MINT);
  if (((await tokenAmount(base, wsolAta)) ?? 0n) < 10_000_000n) {
    await sendAndConfirmTransaction(
      base,
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, wsolAta, authority.publicKey, NATIVE_MINT),
        SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: wsolAta, lamports: 10_000_000 }),
        createSyncNativeInstruction(wsolAta),
      ),
      [authority],
    );
  }

  const runs: Record<string, unknown> = {};
  for (const [label, mint, amount] of [
    ["usdc", DEVNET_USDC, 100_000n],
    ["wsol", NATIVE_MINT, 10_000_000n],
  ] as const) {
    try {
      runs[label] = await runMint(label, mint, amount, er, outsiderEr);
    } catch (e) {
      expect(`${label}:completed`, false, String(e).slice(0, 2000));
    }
  }

  const status = fail.length === 0 ? "PASS" : "FAIL";
  recordGate("8.4", { status, date: new Date().toISOString().slice(0, 10), runs, failed: fail, checks });
  console.log(`\nGate 8.4: ${status}`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
