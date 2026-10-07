// ZenLo governance on Squads v4 (Story 19.5).
//
// Usage: npx tsx scripts/governance/squads.ts <command> [--flags]
//   create [--time-lock 86400]                   2-of-3 multisig, no config authority (changes need a vote)
//   status                                       members, threshold, time lock, vault, pending proposals
//   propose-rotate --remove <pk> --add <pk>      replace one member (rotation and recovery use this)
//   propose-transfer --lamports <n> --to <pk>    small vault transfer, to prove the time lock on vault spends
//   propose-upgrade --program <id> --buffer <pk> upgrade a program whose authority is the vault
//   approve --index <n> --signer a|b|c
//   execute --index <n> --signer a|b|c
//
// Signer keys: a = the Solana CLI default keypair, b and c live in ~/.config/zenlo/governance/.
// These are Devnet rehearsal signers held on one machine. They are NOT independent; before any
// external pilot, rotate b and c to keys held by two other people (propose-rotate), as the story
// requires. State is written to docs/governance-evidence.json.
import * as multisig from "@sqds/multisig";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { Permissions } = multisig.types;
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");
const KEY_DIR = join(homedir(), ".config", "zenlo", "governance");
const EVIDENCE = join(__dirname, "..", "..", "..", "docs", "governance-evidence.json");
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

type Evidence = {
  network: "devnet";
  program: string;
  multisig?: string;
  vault?: string;
  createKey?: string;
  threshold?: number;
  timeLockSeconds?: number;
  members?: { label: string; key: string; note: string }[];
  steps: { at: string; step: string; signature?: string; result?: string; error?: string }[];
};

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

function signer(label: string): Keypair {
  if (label === "a") return loadKeypair(join(homedir(), ".config", "solana", "id.json"));
  mkdirSync(KEY_DIR, { recursive: true });
  const path = join(KEY_DIR, `signer-${label}.json`);
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  return loadKeypair(path);
}

function evidence(): Evidence {
  return existsSync(EVIDENCE)
    ? JSON.parse(readFileSync(EVIDENCE, "utf8"))
    : { network: "devnet", program: multisig.PROGRAM_ID.toBase58(), steps: [] };
}
function save(e: Evidence) {
  writeFileSync(EVIDENCE, JSON.stringify(e, null, 2) + "\n");
}
function log(step: string, extra: Omit<Evidence["steps"][number], "at" | "step"> = {}) {
  const e = evidence();
  e.steps.push({ at: new Date().toISOString(), step, ...extra });
  save(e);
  console.log(step, extra.signature ?? extra.result ?? extra.error ?? "");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function multisigPda(): PublicKey {
  const e = evidence();
  if (!e.multisig) throw new Error("No multisig yet; run create first.");
  return new PublicKey(e.multisig);
}

async function nextIndex(pda: PublicKey): Promise<bigint> {
  const m = await multisig.accounts.Multisig.fromAccountAddress(connection, pda);
  return BigInt(m.transactionIndex.toString()) + 1n;
}

async function create() {
  if (evidence().multisig) throw new Error("A multisig is already recorded in the evidence file.");
  const timeLock = Number(arg("time-lock") ?? 86_400);
  const [a, b, c] = ["a", "b", "c"].map(signer);
  const createKey = Keypair.generate();
  const [pda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vault] = multisig.getVaultPda({ multisigPda: pda, index: 0 });
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
  const all = Permissions.all();
  const signature = await multisig.rpc.multisigCreateV2({
    connection,
    treasury: programConfig.treasury,
    createKey,
    creator: a,
    multisigPda: pda,
    configAuthority: null,
    threshold: 2,
    members: [a, b, c].map((k) => ({ key: k.publicKey, permissions: all })),
    timeLock,
    rentCollector: null,
    memo: "ZenLo V2 governance (Devnet rehearsal)",
  });
  await connection.confirmTransaction(signature, "confirmed");
  const e = evidence();
  Object.assign(e, {
    multisig: pda.toBase58(),
    vault: vault.toBase58(),
    createKey: createKey.publicKey.toBase58(),
    threshold: 2,
    timeLockSeconds: timeLock,
    members: [
      { label: "a", key: a.publicKey.toBase58(), note: "developer deployer key" },
      { label: "b", key: b.publicKey.toBase58(), note: "rehearsal key on the developer machine; rotate before pilot" },
      { label: "c", key: c.publicKey.toBase58(), note: "rehearsal key on the developer machine; rotate before pilot" },
    ],
  });
  save(e);
  log("multisig created, config authority none, 2-of-3", { signature });
}

async function status() {
  const pda = multisigPda();
  const m = await multisig.accounts.Multisig.fromAccountAddress(connection, pda);
  const [vault] = multisig.getVaultPda({ multisigPda: pda, index: 0 });
  const out: Record<string, unknown> = {
    multisig: pda.toBase58(),
    vault: vault.toBase58(),
    vaultLamports: await connection.getBalance(vault),
    threshold: m.threshold,
    timeLock: m.timeLock,
    configAuthority: m.configAuthority.toBase58(),
    members: m.members.map((x) => x.key.toBase58()),
    transactionIndex: m.transactionIndex.toString(),
    proposals: [] as unknown[],
  };
  for (let i = 1n; i <= BigInt(m.transactionIndex.toString()); i++) {
    const [p] = multisig.getProposalPda({ multisigPda: pda, transactionIndex: i });
    const info = await connection.getAccountInfo(p);
    if (!info) continue;
    const [proposal] = multisig.accounts.Proposal.fromAccountInfo(info);
    (out.proposals as unknown[]).push({ index: i.toString(), status: proposal.status, approved: proposal.approved.map((k) => k.toBase58()) });
  }
  console.log(JSON.stringify(out, null, 2));
}

async function proposeConfig(actions: multisig.generated.ConfigAction[], memo: string) {
  const pda = multisigPda();
  const a = signer("a");
  const transactionIndex = await nextIndex(pda);
  const s1 = await multisig.rpc.configTransactionCreate({ connection, feePayer: a, multisigPda: pda, transactionIndex, creator: a.publicKey, actions, memo });
  await connection.confirmTransaction(s1, "confirmed");
  const s2 = await multisig.rpc.proposalCreate({ connection, feePayer: a, creator: a, multisigPda: pda, transactionIndex });
  await connection.confirmTransaction(s2, "confirmed");
  log(`proposal ${transactionIndex}: ${memo}`, { signature: s2 });
}

async function proposeVault(ixs: TransactionInstruction[], memo: string) {
  const pda = multisigPda();
  const a = signer("a");
  const [vault] = multisig.getVaultPda({ multisigPda: pda, index: 0 });
  const transactionIndex = await nextIndex(pda);
  const message = new TransactionMessage({ payerKey: vault, recentBlockhash: (await connection.getLatestBlockhash()).blockhash, instructions: ixs });
  const s1 = await multisig.rpc.vaultTransactionCreate({
    connection, feePayer: a, multisigPda: pda, transactionIndex, creator: a.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message, memo,
  });
  await connection.confirmTransaction(s1, "confirmed");
  const s2 = await multisig.rpc.proposalCreate({ connection, feePayer: a, creator: a, multisigPda: pda, transactionIndex });
  await connection.confirmTransaction(s2, "confirmed");
  log(`proposal ${transactionIndex}: ${memo}`, { signature: s2 });
}

/** BPF upgradeable loader `Upgrade` (instruction 3) with the vault as authority. */
function upgradeIx(program: PublicKey, buffer: PublicKey, authority: PublicKey, spill: PublicKey): TransactionInstruction {
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], BPF_UPGRADEABLE);
  return new TransactionInstruction({
    programId: BPF_UPGRADEABLE,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: program, isSigner: false, isWritable: true },
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: spill, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([3, 0, 0, 0]),
  });
}

async function approve() {
  const pda = multisigPda();
  const index = BigInt(arg("index")!);
  const member = signer(arg("signer") ?? "b");
  const signature = await multisig.rpc.proposalApprove({ connection, feePayer: member, member, multisigPda: pda, transactionIndex: index });
  await connection.confirmTransaction(signature, "confirmed");
  log(`approve ${index} by ${arg("signer") ?? "b"}`, { signature });
}

async function execute() {
  const pda = multisigPda();
  const index = BigInt(arg("index")!);
  const member = signer(arg("signer") ?? "a");
  const [txPda] = multisig.getTransactionPda({ multisigPda: pda, index });
  const info = await connection.getAccountInfo(txPda);
  if (!info) throw new Error(`No transaction ${index}`);
  const isConfig = info.data.subarray(0, 8).equals(Buffer.from(multisig.accounts.configTransactionDiscriminator));
  try {
    const signature = isConfig
      ? await multisig.rpc.configTransactionExecute({ connection, feePayer: member, multisigPda: pda, transactionIndex: index, member, rentPayer: member })
      : await multisig.rpc.vaultTransactionExecute({ connection, feePayer: member, multisigPda: pda, transactionIndex: index, member: member.publicKey });
    const res = await connection.confirmTransaction(signature, "confirmed");
    if (res.value.err) throw new Error(JSON.stringify(res.value.err));
    log(`execute ${index}`, { signature, result: "executed" });
  } catch (e) {
    const msg = String((e as { logs?: string[] }).logs?.find((l) => l.includes("Error")) ?? e).slice(0, 300);
    log(`execute ${index} refused`, { error: msg });
    process.exitCode = 1;
  }
}

const commands: Record<string, () => Promise<void>> = {
  create,
  status,
  approve,
  execute,
  "propose-rotate": () =>
    proposeConfig(
      [
        { __kind: "AddMember", newMember: { key: new PublicKey(arg("add")!), permissions: Permissions.all() } },
        { __kind: "RemoveMember", oldMember: new PublicKey(arg("remove")!) },
      ],
      `rotate ${arg("remove")} -> ${arg("add")}`,
    ),
  "propose-transfer": async () => {
    const [vault] = multisig.getVaultPda({ multisigPda: multisigPda(), index: 0 });
    await proposeVault([SystemProgram.transfer({ fromPubkey: vault, toPubkey: new PublicKey(arg("to")!), lamports: Number(arg("lamports") ?? 1000) })], "time-locked vault transfer");
  },
  "propose-upgrade": async () => {
    const [vault] = multisig.getVaultPda({ multisigPda: multisigPda(), index: 0 });
    const spill = new PublicKey(arg("spill") ?? signer("a").publicKey.toBase58());
    await proposeVault([upgradeIx(new PublicKey(arg("program")!), new PublicKey(arg("buffer")!), vault, spill)], `upgrade ${arg("program")}`);
  },
};

const cmd = process.argv[2];
if (!commands[cmd]) {
  console.error(`Commands: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
commands[cmd]().catch((e) => {
  console.error(e);
  process.exit(1);
});
