// Gate 8.3: ER-only records. A record created inside the TEE is readable only
// by its member, and never appears on Solana, before or after its sponsor commits.
// Run: npx tsx spikes/gate-8-3.ts
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
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
import { TEE_RPC, authority, base, program, sendEr, sleep, teeConnection, waitFor } from "./lib/custody";

const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

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
  const anonymous = new Connection(TEE_RPC, "confirmed");

  // Sponsor: a delegated probe.
  const id = randomBytes(32);
  const [probe] = PublicKey.findProgramAddressSync([Buffer.from("probe"), id], program.programId);
  const permission = permissionPdaFromAccount(probe);
  const setup = await sendAndConfirmTransaction(
    base,
    new Transaction().add(
      await program.methods
        .createProbe([...id], Keypair.generate().publicKey)
        .accountsPartial({ authority: authority.publicKey, probe, permission })
        .instruction(),
      // The sponsor pays the record's ER rent, so it needs lamports above its own minimum.
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

  // Create the ER-only record with a random marker.
  const marker = randomBytes(32);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from("record"), probe.toBuffer()], program.programId);
  const create = await sendEr(
    er,
    await program.methods
      .createRecord([...marker])
      .accountsPartial({
        authority: authority.publicKey,
        probe,
        record,
        recordPermission: permissionPdaFromAccount(record),
        vault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        permissionProgram: PERMISSION_PROGRAM_ID,
      })
      .instruction(),
  );
  await sleep(2000);

  const view = async (c: Connection) => {
    try {
      const i = await c.getAccountInfo(record);
      return i ? { visible: true, owner: i.owner.toBase58(), hasMarker: i.data.includes(marker) } : { visible: false };
    } catch (e) {
      return { visible: false, error: String(e).slice(0, 120) };
    }
  };
  const mine = await view(er);
  expect("member-reads-record", mine.visible && "hasMarker" in mine && mine.hasMarker === true, mine);
  const theirs = await view(outsider);
  expect("outsider-cannot-read-record", !("hasMarker" in theirs && theirs.hasMarker), theirs);
  const anon = await view(anonymous);
  expect("anonymous-cannot-read-record", !("hasMarker" in anon && anon.hasMarker), anon);
  expect("record-absent-on-base-while-delegated", (await base.getAccountInfo(record)) === null, record.toBase58());

  // Commit and undelegate the sponsor; the record must still never reach Solana.
  const undelegate = await sendEr(
    er,
    await program.methods.undelegateProbe().accountsPartial({ authority: authority.publicKey, probe }).instruction(),
  );
  await waitFor("probe back on base", () => base.getAccountInfo(probe), (i) => i.owner.equals(program.programId), 120);
  await sleep(5000);
  expect("record-absent-on-base-after-sponsor-commit", (await base.getAccountInfo(record)) === null, record.toBase58());

  const sigs = await base.getSignaturesForAddress(probe, { limit: 20 });
  let markerOnBase = false;
  for (const s of sigs) {
    const t = await base.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (t && Buffer.from(t.transaction.message.serialize()).includes(marker)) markerOnBase = true;
  }
  expect("marker-never-in-base-transactions", !markerOnBase, { transactionsChecked: sigs.length });
  checks["record-in-er-after-sponsor-undelegated"] = await view(er);
  checks["validator-restart"] =
    "Not testable: the Devnet TEE is hosted by MagicBlock. ER-only records are treated as non-durable until a restart is observed.";

  const status = fail.length === 0 ? "PASS" : "FAIL";
  recordGate("8.3", {
    status,
    date: new Date().toISOString().slice(0, 10),
    probe: probe.toBase58(),
    record: record.toBase58(),
    signatures: { setup, create, undelegate },
    failed: fail,
    checks,
  });
  console.log(`\nGate 8.3: ${status}`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
