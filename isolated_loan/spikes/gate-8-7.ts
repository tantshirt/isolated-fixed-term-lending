// Gate 8.7: what a base-layer commit of a permissioned account exposes.
// Creates a probe, writes a marker inside the TEE, commits and undelegates,
// then inspects the base account and every base transaction that touched it.
// Run: npx tsx spikes/gate-8-7.ts
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
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
const MARKER = 8_707_870_787n;
const markerBytes = Buffer.alloc(8);
markerBytes.writeBigUInt64LE(MARKER);

async function main() {
  const checks: Record<string, unknown> = {};
  const er = await teeConnection(authority);

  const id = randomBytes(32);
  const [probe] = PublicKey.findProgramAddressSync([Buffer.from("probe"), id], program.programId);
  const permission = permissionPdaFromAccount(probe);
  const reader = Keypair.generate().publicKey;
  const setup = await sendAndConfirmTransaction(
    base,
    new Transaction().add(
      await program.methods
        .createProbe([...id], reader)
        .accountsPartial({ authority: authority.publicKey, probe, permission })
        .instruction(),
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

  const write = await sendEr(
    er,
    await program.methods.writeProbe(new BN(MARKER.toString())).accountsPartial({ authority: authority.publicKey, probe }).instruction(),
  );
  const before = await base.getAccountInfo(probe);
  checks["base-before-commit"] = { containsMarker: !!before?.data.includes(markerBytes) };

  const undelegate = await sendEr(
    er,
    await program.methods.undelegateProbe().accountsPartial({ authority: authority.publicKey, probe }).instruction(),
  );
  const after = await waitFor("probe back on base", () => base.getAccountInfo(probe), (i) => i.owner.equals(program.programId), 120);
  checks["base-account-after-commit"] = {
    owner: after.owner.toBase58(),
    containsMarker: after.data.includes(markerBytes),
  };

  // Every base transaction touching the probe after the write.
  await sleep(5000);
  const sigs = await base.getSignaturesForAddress(probe, { limit: 20 });
  const txs = [];
  for (const s of sigs) {
    if (s.signature === setup) continue;
    const t = await base.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    const raw = t ? Buffer.from(t.transaction.message.serialize()) : Buffer.alloc(0);
    const logs = t?.meta?.logMessages ?? [];
    txs.push({
      signature: s.signature,
      programs: [...new Set(t?.transaction.message.staticAccountKeys.map((k) => k.toBase58()).filter((k) => /^(DEL|Magic|ACL|HwK4)/.test(k)))],
      markerInMessage: raw.includes(markerBytes),
      markerInLogs: logs.some((l) => l.includes(MARKER.toString())),
    });
  }
  checks["base-commit-transactions"] = txs;

  const plaintextOnBase = after.data.includes(markerBytes) || txs.some((t) => t.markerInMessage);
  const finding = plaintextOnBase
    ? "Committing a permissioned account writes its plaintext data to Solana. Terms, negotiations, and approvals must never be committed; keep them ER-only and settle only opaque receipts and token balances."
    : "No plaintext found on base after commit.";
  console.log(JSON.stringify(checks, null, 2));
  console.log(`\nGate 8.7: PASS (inspection complete). Finding: ${finding}`);
  recordGate("8.7", {
    status: "PASS",
    date: new Date().toISOString().slice(0, 10),
    probe: probe.toBase58(),
    signatures: { setup, write, undelegate },
    plaintextOnBaseAfterCommit: plaintextOnBase,
    blocks: plaintextOnBase ? ["committing private terms or negotiation records to Solana"] : [],
    finding,
    checks,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
