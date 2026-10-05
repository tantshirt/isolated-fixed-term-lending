// Gate 8.5: the canonical Pyth Receiver account read and validated inside the PER.
// Run after gate-8-2.ts: npx tsx spikes/gate-8-5.ts
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAuthToken, verifyTeeRpcIntegrity } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { recordGate } from "./lib/evidence";

const BASE_RPC = "https://api.devnet.solana.com";
const TEE_RPC = "https://devnet-tee.magicblock.app";
const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
const SOL_USD = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
// MagicBlock real-time pricing oracle, SOL/USD on Devnet (owner PriCems…). Must be rejected.
const MAGICBLOCK_FEED = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");

const idl = JSON.parse(readFileSync(new URL("../target/idl/private_loan.json", import.meta.url), "utf8"));
const evidence = JSON.parse(readFileSync(new URL("../../docs/magicblock-evidence.json", import.meta.url), "utf8"));
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))),
);
const probe = new PublicKey(evidence.gates["8.2"].probe);
// Shard-0 SOL/USD push account, derived as in app/lib/constants.ts.
const PYTH_PUSH_PROGRAM_ID = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
const shard = (n: number) =>
  PublicKey.findProgramAddressSync([Buffer.from([n, 0]), Buffer.from(SOL_USD, "hex")], PYTH_PUSH_PROGRAM_ID)[0];
const priceAccount = shard(0);
// Shard 1 is canonical (owner rec5EK…, SOL/USD feed) but not kept fresh on Devnet.
const staleAccount = shard(1);

// PriceUpdateV2: 8 disc, 32 write_authority, 1 verification (Full=1 byte, Partial=2),
// then feed_id 32, price i64, conf u64, exponent i32, publish_time i64.
function publishTime(data: Buffer): { publishTime: number; price: string; exponent: number } {
  const v = data[40];
  const off = 8 + 32 + (v === 0 ? 2 : 1) + 32;
  return {
    price: data.readBigInt64LE(off).toString(),
    exponent: data.readInt32LE(off + 16),
    publishTime: Number(data.readBigInt64LE(off + 20)),
  };
}

async function main() {
  const checks: Record<string, unknown> = {};
  const fail: string[] = [];
  const expect = (name: string, ok: boolean, detail: unknown) => {
    checks[name] = { ok, detail };
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail);
    if (!ok) fail.push(name);
  };

  await verifyTeeRpcIntegrity(TEE_RPC);
  const { token } = await getAuthToken(TEE_RPC, authority.publicKey, async (m) =>
    nacl.sign.detached(m, authority.secretKey),
  );
  const er = new Connection(`${TEE_RPC}?token=${token}`, "confirmed");
  const base = new Connection(BASE_RPC, "confirmed");
  const program = new Program(idl, new AnchorProvider(base, new Wallet(authority), {}));

  // 1. Base and ER copies of the canonical account.
  const baseInfo = await base.getAccountInfo(priceAccount);
  const erInfo = await er.getAccountInfo(priceAccount);
  const now = Math.floor(Date.now() / 1000);
  const baseView = baseInfo && { owner: baseInfo.owner.toBase58(), ...publishTime(baseInfo.data), ageSeconds: now - publishTime(baseInfo.data).publishTime };
  const erView = erInfo && { owner: erInfo.owner.toBase58(), ...publishTime(erInfo.data), ageSeconds: now - publishTime(erInfo.data).publishTime };
  expect("canonical-owner-on-base", baseView?.owner === PYTH_RECEIVER, { account: priceAccount.toBase58(), ...baseView });
  expect("er-clone-keeps-canonical-owner", erView?.owner === PYTH_RECEIVER, erView ?? "no clone visible");

  const send = async (priceUpdate: PublicKey) => {
    const ix = await program.methods
      .checkPrice()
      .accountsPartial({ authority: authority.publicKey, probe, priceUpdate })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = authority.publicKey;
    tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    tx.sign(authority);
    const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const res = await er.confirmTransaction(sig, "confirmed");
    const t = await er.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    const logs = (t?.meta?.logMessages ?? []).filter((l) => /Error|error|log:/.test(l));
    return { sig, err: res.value.err, logs };
  };

  // 2. Fresh canonical account inside the PER must pass.
  const canonical = await send(priceAccount);
  const afterInfo = await er.getAccountInfo(probe);
  const stored = afterInfo ? program.coder.accounts.decode("probe", afterInfo.data) : null;
  expect("fresh-canonical-price-accepted", (erView?.ageSeconds ?? Infinity) <= 60 && canonical.err === null, {
    ...canonical,
    storedPrice: stored?.price.toString(),
    storedExponent: stored?.priceExponent,
  });

  // 3. Stale canonical account inside the PER must fail closed with StalePrice.
  const staleInfo = await er.getAccountInfo(staleAccount);
  const stale = await send(staleAccount);
  expect("stale-canonical-price-fails-closed", stale.err !== null && stale.logs.some((l) => l.includes("StalePrice")), {
    account: staleAccount.toBase58(),
    owner: staleInfo?.owner.toBase58(),
    ageSeconds: staleInfo ? now - publishTime(staleInfo.data).publishTime : null,
    ...stale,
  });

  // 4. Clone lag: how far the PER copy trails the base account.
  const lags: number[] = [];
  for (let i = 0; i < 6; i++) {
    const [b, e] = await Promise.all([base.getAccountInfo(priceAccount), er.getAccountInfo(priceAccount)]);
    if (b && e) lags.push(publishTime(b.data).publishTime - publishTime(e.data).publishTime);
    await new Promise((r) => setTimeout(r, 2000));
  }
  checks["clone-lag-seconds"] = { samples: lags, max: Math.max(...lags) };
  console.log("INFO clone-lag-seconds", lags);

  // 5. MagicBlock pricing oracle has a compatible layout but must fail the owner check.
  const mbInfo = await er.getAccountInfo(MAGICBLOCK_FEED);
  const mb = await send(MAGICBLOCK_FEED);
  expect("magicblock-feed-rejected-by-owner", mb.err !== null && mb.logs.some((l) => l.includes("InvalidPriceOwner")), {
    owner: mbInfo?.owner.toBase58(),
    ...mb,
  });

  const status = fail.length === 0 ? "PASS" : "FAIL";
  recordGate("8.5", {
    status,
    date: new Date().toISOString().slice(0, 10),
    priceAccount: priceAccount.toBase58(),
    staleAccount: staleAccount.toBase58(),
    failed: fail,
    checks,
  });
  console.log(`\nGate 8.5: ${status}`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
