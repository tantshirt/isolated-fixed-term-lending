/**
 * Story 27.1: writes the accounts the Arcium localnet test preloads (Anchor.toml
 * [[test.validator.account]]), because their owners (private_loan_v2, isolated_loan_v2, SAS) are
 * not deployed on the Arcium localnet:
 *
 * - the borrower's HistoryAttestation (owner private_loan_v2), attested an hour ago: 6 on time,
 *   0 late, 0 liquidated, 0 defaulted;
 * - isolated_loan_v2 Config (credential issuer = a fixed test key) and an enabled CreditConfig;
 * - the borrower's SAS credit credential for band 3, valid for 90 days.
 *
 * The borrower is the provider wallet (~/.config/solana/id.json). Run right before `arcium test`
 * (`npm run test:integration`): the attestation must be under 30 days old.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PRIVATE_LOAN_V2 = new PublicKey("JAzy8NP6V8AGrAko8vfgrD44BDghN6eLwqB7vjuYhHNq");
const ISOLATED_LOAN_V2 = new PublicKey("8hxagcQkw1Km6PWZgpA92qUnqvnFufC7tx2jvxf9Ko8m");
const SAS = new PublicKey("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");

/** Fixed test keys, so the test can recompute the same addresses. */
export const fixedKey = (label: string) => Keypair.fromSeed(createHash("sha256").update(`zenlo-27.1-${label}`).digest()).publicKey;
export const ISSUER = fixedKey("issuer");
export const CREDENTIAL = fixedKey("credential");
export const SCHEMA = fixedKey("schema");

const disc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };

export function borrowerKey(): PublicKey {
  const raw = JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw)).publicKey;
}

export function addresses(borrower: PublicKey) {
  return {
    history: PublicKey.findProgramAddressSync([Buffer.from("credit-attestation"), borrower.toBuffer()], PRIVATE_LOAN_V2),
    config: PublicKey.findProgramAddressSync([Buffer.from("config")], ISOLATED_LOAN_V2),
    credit: PublicKey.findProgramAddressSync([Buffer.from("credit")], ISOLATED_LOAN_V2),
    sas: PublicKey.findProgramAddressSync([Buffer.from("attestation"), CREDENTIAL.toBuffer(), SCHEMA.toBuffer(), borrower.toBuffer()], SAS),
  };
}

function write(dir: string, name: string, pubkey: PublicKey, owner: PublicKey, data: Buffer) {
  const account = {
    pubkey: pubkey.toBase58(),
    account: { lamports: 10_000_000, data: [data.toString("base64"), "base64"], owner: owner.toBase58(), executable: false, rentEpoch: 0, space: data.length },
  };
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(account, null, 1));
}

function main() {
  const borrower = borrowerKey();
  const a = addresses(borrower);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const dir = path.join(__dirname, "localnet");
  fs.mkdirSync(dir, { recursive: true });

  const [onTime, late, liquidated, defaulted] = [6, 0, 0, 0];
  write(dir, "history-attestation", a.history[0], PRIVATE_LOAN_V2, Buffer.concat([
    disc("HistoryAttestation"), u8(1), borrower.toBuffer(),
    u32(onTime + late), u32(onTime), u32(late), u32(liquidated), u32(defaulted),
    u16(onTime + late + liquidated + defaulted), u64(1_000n), i64(now - 3_600n), u8(a.history[1]),
  ]));

  const k = (l: string) => fixedKey(l).toBuffer();
  write(dir, "loan-config", a.config[0], ISOLATED_LOAN_V2, Buffer.concat([
    disc("Config"), u8(1), k("governance"), k("ai-admin"), k("ai-worker"), k("pool-admin"), ISSUER.toBuffer(), k("keeper"), u8(a.config[1]),
  ]));
  write(dir, "credit-config", a.credit[0], ISOLATED_LOAN_V2, Buffer.concat([
    disc("CreditConfig"), u8(1), u8(1), SAS.toBuffer(), CREDENTIAL.toBuffer(), SCHEMA.toBuffer(), u8(a.credit[1]), Buffer.alloc(32),
  ]));

  const payload = Buffer.concat([u8(3), i64(now + 90n * 86_400n)]);
  write(dir, "sas-credential", a.sas[0], SAS, Buffer.concat([
    u8(2), borrower.toBuffer(), CREDENTIAL.toBuffer(), SCHEMA.toBuffer(), u32(payload.length), payload, ISSUER.toBuffer(), i64(0n), Buffer.alloc(32),
  ]));
  console.log(`Wrote localnet accounts for borrower ${borrower.toBase58()} to ${dir}`);
}

if (require.main === module) main();
