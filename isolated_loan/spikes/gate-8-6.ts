// Gate 8.6: private scheduled execution with Hydra inside the TEE.
// A crank schedules the permissionless `crank_tick` on a private probe. We watch
// the hosted cranker trigger it (or trigger it ourselves if none is running),
// settle the probe, and check that later ticks change nothing.
// Run: npx tsx spikes/gate-8-6.ts
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { randomBytes } from "node:crypto";
import { recordGate } from "./lib/evidence";
import { authority, base, program, sendEr, sleep, teeConnection, waitFor } from "./lib/custody";

const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const HYDRA_EPHEMERAL = new PublicKey("eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf");
const SETTLED = (1n << 64n) - 1n;
const CRANK_TICK = Buffer.from([150, 187, 23, 252, 153, 201, 51, 133]);

/** Unused: the wallet cannot sponsor a crank in the ER (InvalidAccountForFee). Kept for reference. */
function hydraCreateData(seed: Buffer, cancelAuthority: PublicKey, interval: bigint, remaining: bigint, target: PublicKey) {
  const metas = [{ pubkey: target, writable: true }];
  const body = Buffer.alloc(1 + 2 + 32 + 33 * metas.length + CRANK_TICK.length);
  let o = 0;
  body.writeUInt8(metas.length, o); o += 1;
  body.writeUInt16LE(CRANK_TICK.length, o); o += 2;
  program.programId.toBuffer().copy(body, o); o += 32;
  for (const m of metas) {
    body.writeUInt8(m.writable ? 0b10 : 0, o); o += 1;
    m.pubkey.toBuffer().copy(body, o); o += 32;
  }
  CRANK_TICK.copy(body, o);
  const head = Buffer.alloc(1 + 32 + 32 + 8 * 4 + 4);
  o = 0;
  head.writeUInt8(0, o); o += 1; // CREATE
  seed.copy(head, o); o += 32;
  cancelAuthority.toBuffer().copy(head, o); o += 32;
  head.writeBigUInt64LE(0n, o); o += 8; // start_slot: now
  head.writeBigUInt64LE(interval, o); o += 8;
  head.writeBigUInt64LE(remaining, o); o += 8;
  head.writeBigUInt64LE(0n, o); o += 8; // priority_tip
  head.writeUInt32LE(0, o);
  return Buffer.concat([head, body]);
}

async function readValue(c: Connection, probe: PublicKey): Promise<bigint | null> {
  const i = await c.getAccountInfo(probe);
  return i ? BigInt(program.coder.accounts.decode("probe", i.data).value.toString()) : null;
}

async function main() {
  const checks: Record<string, unknown> = {};
  const fail: string[] = [];
  const expect = (name: string, ok: boolean, detail: unknown) => {
    checks[name] = { ok, detail };
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail);
    if (!ok) fail.push(name);
  };
  const er = await teeConnection(authority);
  const outsider = await teeConnection(Keypair.generate());

  const id = randomBytes(32);
  const [probe] = PublicKey.findProgramAddressSync([Buffer.from("probe"), id], program.programId);
  const permission = permissionPdaFromAccount(probe);
  const setup = await sendAndConfirmTransaction(
    base,
    new Transaction().add(
      await program.methods.createProbe([...id], Keypair.generate().publicKey).accountsPartial({ authority: authority.publicKey, probe, permission }).instruction(),
      SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: probe, lamports: 10_000_000 }),
      await program.methods
        .delegateProbe([...id])
        .accountsPartial({
          authority: authority.publicKey,
          probe,
          permission,
          permissionBuffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permission, PERMISSION_PROGRAM_ID),
          permissionRecord: delegationRecordPdaFromDelegatedAccount(permission),
          permissionMetadata: delegationMetadataPdaFromDelegatedAccount(permission),
          validator: TEE_VALIDATOR,
        })
        .instruction(),
    ),
    [authority],
  );
  await waitFor("probe in ER", () => er.getAccountInfo(probe), () => true);

  // Create the crank inside the ER through the program, with the probe as sponsor.
  // Try the documented seed layout first, then the legacy one. Retry while the ER
  // still runs an older build of the program (Anchor error 101).
  const seed = randomBytes(32);
  const candidates = [
    PublicKey.findProgramAddressSync([Buffer.from("crank"), probe.toBuffer(), seed], HYDRA_EPHEMERAL)[0],
    PublicKey.findProgramAddressSync([Buffer.from("crank"), seed], HYDRA_EPHEMERAL)[0],
  ];
  let crank: PublicKey | null = null;
  let createSig = "";
  const createErrors: string[] = [];
  for (const c of candidates) {
    for (let attempt = 0; attempt < 12 && !crank; attempt++) {
      try {
        createSig = await sendEr(
          er,
          await program.methods
            .scheduleTick([...seed], new BN(20), new BN(6))
            .accountsPartial({
              authority: authority.publicKey,
              probe,
              crank: c,
              vault: EPHEMERAL_VAULT_ID,
              magicProgram: MAGIC_PROGRAM_ID,
              hydraProgram: HYDRA_EPHEMERAL,
            })
            .instruction(),
        );
        crank = c;
      } catch (e) {
        const msg = String(e);
        if (msg.includes('"Custom":101')) {
          await sleep(10000);
          continue;
        }
        createErrors.push(msg.slice(0, 300));
        break;
      }
    }
    if (crank) break;
  }
  expect("crank-created-in-er", crank !== null, crank ? { crank: crank.toBase58(), createSig } : createErrors);
  if (!crank) return finish();

  // Watch for the hosted cranker.
  let v = 0n;
  for (let i = 0; i < 45 && v === 0n; i++) {
    v = (await readValue(er, probe)) ?? 0n;
    if (v === 0n) await sleep(1000);
  }
  const hostedCranker = v > 0n;
  checks["hosted-cranker-observed"] = { observed: hostedCranker, ticksAfterWait: v.toString() };
  // A Trigger must be followed in the same transaction by the exact scheduled
  // instruction; Hydra byte-matches it through the instructions sysvar.
  const trigger = async () => {
    const tx = new Transaction().add(
      new TransactionInstruction({
        programId: HYDRA_EPHEMERAL,
        keys: [
          { pubkey: crank!, isSigner: false, isWritable: true },
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
      new TransactionInstruction({
        programId: program.programId,
        keys: [{ pubkey: probe, isSigner: false, isWritable: true }],
        data: CRANK_TICK,
      }),
    );
    tx.feePayer = authority.publicKey;
    tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    tx.sign(authority);
    const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const res = await er.confirmTransaction(sig, "confirmed");
    if (res.value.err) throw new Error(`trigger ${sig} failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  };
  if (!hostedCranker) {
    try {
      checks["manual-trigger"] = await trigger();
      v = (await readValue(er, probe)) ?? 0n;
    } catch (e) {
      checks["manual-trigger"] = String(e).slice(0, 400);
    }
  }
  expect("scheduled-tick-ran-on-private-probe", v > 0n, { value: v.toString(), via: hostedCranker ? "hosted cranker" : "manual trigger" });

  // The scheduler needs no read permission: the crank holds only the probe address
  // and an 8-byte discriminator. Record what an outsider sees of the crank and probe.
  const crankView = await outsider.getAccountInfo(crank);
  checks["outsider-crank-view"] = crankView ? { owner: crankView.owner.toBase58(), len: crankView.data.length } : null;
  expect("outsider-cannot-read-probe", (await readValue(outsider, probe).catch(() => null)) === null, "probe hidden");

  // Settle, then confirm later ticks are harmless.
  await sendEr(er, await program.methods.writeProbe(new BN(SETTLED.toString())).accountsPartial({ authority: authority.publicKey, probe }).instruction());
  if (hostedCranker) await sleep(20000);
  else {
    await sleep(10000); // interval is 20 slots (~8 s at 400 ms)
    try {
      await trigger();
    } catch (e) {
      checks["post-settle-trigger"] = String(e).slice(0, 300);
    }
  }
  const after = await readValue(er, probe);
  expect("tick-after-settlement-is-noop", after === SETTLED, { value: after?.toString() });

  // Clean up the crank.
  try {
    checks["cancel"] = await sendEr(
      er,
      new TransactionInstruction({
        programId: HYDRA_EPHEMERAL,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: crank, isSigner: false, isWritable: true },
          { pubkey: authority.publicKey, isSigner: false, isWritable: true },
          { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
          { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([2]),
      }),
    );
  } catch (e) {
    checks["cancel"] = String(e).slice(0, 300);
  }
  return finish();

  function finish() {
    const status = fail.length === 0 ? "PASS" : "FAIL";
    recordGate("8.6", { status, date: new Date().toISOString().slice(0, 10), probe: probe.toBase58(), crank: crank?.toBase58(), setup, failed: fail, checks });
    console.log(`\nGate 8.6: ${status}`);
    process.exit(fail.length === 0 ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
