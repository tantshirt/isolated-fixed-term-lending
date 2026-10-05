// Gate 8.2: TEE attestation, auth tokens, and who can read a permissioned account.
// Run: npx tsx spikes/gate-8-2.ts   (Devnet, uses ~/.config/solana/id.json)
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  PERMISSION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  getAuthToken,
  permissionPdaFromAccount,
  verifyTeeRpcIntegrity,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { recordGate } from "./lib/evidence";

const BASE_RPC = "https://api.devnet.solana.com";
const TEE_RPC = "https://devnet-tee.magicblock.app";
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const PROBE_SEED = Buffer.from("probe");

const idl = JSON.parse(readFileSync(new URL("../target/idl/private_loan.json", import.meta.url), "utf8"));
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))),
);
const reader = Keypair.generate();
const outsider = Keypair.generate();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function teeConnection(kp: Keypair): Promise<Connection> {
  const { token } = await getAuthToken(TEE_RPC, kp.publicKey, async (m) =>
    nacl.sign.detached(m, kp.secretKey),
  );
  return new Connection(`${TEE_RPC}?token=${token}`, "confirmed");
}

async function main() {
  const checks: Record<string, unknown> = {};
  const fail: string[] = [];
  const expect = (name: string, ok: boolean, detail: unknown) => {
    checks[name] = { ok, detail };
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail);
    if (!ok) fail.push(name);
  };

  // 1. Attestation before any private request.
  await verifyTeeRpcIntegrity(TEE_RPC);
  expect("tee-attestation", true, "verifyTeeRpcIntegrity resolved");

  const base = new Connection(BASE_RPC, "confirmed");
  const program = new Program(idl, new AnchorProvider(base, new Wallet(authority), {}));

  // 2. Create the probe and its permission, then delegate both, in one transaction.
  const id = randomBytes(32);
  const [probe] = PublicKey.findProgramAddressSync([PROBE_SEED, id], program.programId);
  const permission = permissionPdaFromAccount(probe);
  const createIx = await program.methods
    .createProbe([...id], reader.publicKey)
    .accountsPartial({ authority: authority.publicKey, probe, permission })
    .instruction();
  const delegateIx = await program.methods
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
    .instruction();
  const setupSig = await sendAndConfirmTransaction(base, new Transaction().add(createIx, delegateIx), [authority]);
  expect("atomic-create-and-delegate", true, { probe: probe.toBase58(), setupSig });

  // 3. Tokens for each role.
  const asAuthority = await teeConnection(authority);
  const asReader = await teeConnection(reader);
  const asOutsider = await teeConnection(outsider);
  const anonymous = new Connection(TEE_RPC, "confirmed");
  expect("auth-tokens", true, "authority, reader, outsider tokens issued");

  // Wait for the validator to pick up the delegation.
  for (let i = 0; i < 30 && !(await asAuthority.getAccountInfo(probe)); i++) await sleep(1000);

  // 4. Outsider subscription opened before the write.
  const outsiderEvents: unknown[] = [];
  const subId = asOutsider.onAccountChange(probe, (info) => outsiderEvents.push(info.data.length));

  const writeIx = await program.methods
    .writeProbe(new (await import("bn.js")).default(424242))
    .accountsPartial({ authority: authority.publicKey, probe })
    .instruction();
  const writeTx = new Transaction().add(writeIx);
  writeTx.feePayer = authority.publicKey;
  writeTx.recentBlockhash = (await asAuthority.getLatestBlockhash()).blockhash;
  writeTx.sign(authority);
  const writeSig = await asAuthority.sendRawTransaction(writeTx.serialize(), { skipPreflight: true });
  await asAuthority.confirmTransaction(writeSig, "confirmed");
  expect("member-write-in-er", true, { writeSig });
  await sleep(3000);

  // 5. Reads by role.
  const read = async (c: Connection) => {
    try {
      const info = await c.getAccountInfo(probe);
      if (!info) return { visible: false, value: null };
      const decoded = program.coder.accounts.decode("probe", info.data);
      return { visible: true, value: decoded.value.toString() };
    } catch (e) {
      return { visible: false, error: String(e).slice(0, 160) };
    }
  };
  const authorityView = await read(asAuthority);
  const readerView = await read(asReader);
  const outsiderView = await read(asOutsider);
  const anonymousView = await read(anonymous);
  expect("authority-reads", authorityView.value === "424242", authorityView);
  expect("reader-reads", readerView.value === "424242", readerView);
  expect("outsider-cannot-read", outsiderView.value !== "424242", outsiderView);
  expect("anonymous-cannot-read", anonymousView.value !== "424242", anonymousView);

  // getProgramAccounts as outsider.
  try {
    const gpa = await asOutsider.getProgramAccounts(program.programId);
    const leaked = gpa.some((a) => {
      try {
        return program.coder.accounts.decode("probe", a.account.data).value.toString() === "424242";
      } catch {
        return false;
      }
    });
    expect("outsider-gpa-no-contents", !leaked, { returned: gpa.length });
  } catch (e) {
    expect("outsider-gpa-no-contents", true, { error: String(e).slice(0, 160) });
  }

  // Transaction details and logs.
  const txView = async (c: Connection) => {
    try {
      const t = await c.getTransaction(writeSig, { maxSupportedTransactionVersion: 0 });
      return { found: !!t, logs: t?.meta?.logMessages?.length ?? 0 };
    } catch (e) {
      return { found: false, error: String(e).slice(0, 160) };
    }
  };
  const readerTx = await txView(asReader);
  const outsiderTx = await txView(asOutsider);
  expect("reader-sees-tx-logs", readerTx.found, readerTx);
  expect("outsider-no-tx-logs", !outsiderTx.found || outsiderTx.logs === 0, outsiderTx);

  await asOutsider.removeAccountChangeListener(subId);
  expect("outsider-subscription-silent", outsiderEvents.length === 0, { events: outsiderEvents.length });

  // 6. Base layer still shows the account as delegated, without the written value.
  const baseInfo = await base.getAccountInfo(probe);
  let baseValue: string | null = null;
  try {
    baseValue = baseInfo ? program.coder.accounts.decode("probe", baseInfo.data).value.toString() : null;
  } catch {
    baseValue = null;
  }
  expect("base-layer-no-er-value", baseValue !== "424242", {
    owner: baseInfo?.owner.toBase58(),
    baseValue,
  });

  const status = fail.length === 0 ? "PASS" : "FAIL";
  recordGate("8.2", {
    status,
    date: new Date().toISOString().slice(0, 10),
    probe: probe.toBase58(),
    signatures: { setup: setupSig, write: writeSig },
    failed: fail,
    checks,
  });
  console.log(`\nGate 8.2: ${status}`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
