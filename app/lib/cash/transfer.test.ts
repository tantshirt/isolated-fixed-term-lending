import test from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { KeypairWallet } from "../keypair-wallet";
import { DEVNET_GENESIS_HASH } from "../constants";
import { readSubmissionStorage, SubmissionError } from "../transaction-lifecycle";
import { submitCashTransfer } from "./transfer";
import { RAMPS, type ReviewedTransfer } from "./moneygram";
import { claimPollBatch } from "../../convex/cash";

function fixture() {
  const signer = new KeypairWallet(Keypair.generate());
  const rampsId = Keypair.generate().publicKey.toBase58();
  const key = `zenlo:cash-transfer:sandbox:${signer.publicKey}:${rampsId}`;
  const transfer: ReviewedTransfer = { to: SystemProgram.programId.toBase58(), mint: RAMPS.sandbox.usdcMint, atoms: 1n, decimals: 6, network: "testnet" };
  let sends = 0;
  let confirmed = false;
  let disconnect = false;
  const rpc = {
    getGenesisHash: async () => DEVNET_GENESIS_HASH,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: async () => ({ value: { err: null } }),
    sendRawTransaction: async () => {
      sends++;
      assert.ok(readSubmissionStorage(key), "provider recovery signature is durable before broadcasting");
      if (disconnect) throw new Error("RPC disconnected");
      return "sent";
    },
    confirmTransaction: async () => { confirmed = true; return { value: { err: null } }; },
    getSignatureStatuses: async () => ({ value: [confirmed ? { err: null, confirmationStatus: "confirmed" } : null] }),
    getBlockHeight: async () => 90,
  };
  const transaction = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: SystemProgram.programId, lamports: 1 }));
  const send = (record: (signature: string) => Promise<unknown>) => submitCashTransfer(rpc as unknown as Connection, signer, transaction(), rampsId, "sandbox", transfer, record);
  return { send, key, count: () => sends, disconnect: () => { disconnect = true; }, confirm: () => { confirmed = true; } };
}

test("backend recording failure after confirmation never sends a second transfer", async () => {
  const f = fixture();
  await assert.rejects(f.send(async () => { throw new Error("backend unavailable"); }), /backend unavailable/);
  assert.equal((readSubmissionStorage(f.key) as { confirmed: boolean }).confirmed, true);
  const signatures: string[] = [];
  const signature = await f.send(async (s) => { signatures.push(s); });
  assert.deepEqual(signatures, [signature]);
  assert.equal(f.count(), 1);
});

test("uncertain cash-out retries reconcile the saved signature before considering another send", async () => {
  const f = fixture();
  f.disconnect();
  const uncertain = (e: unknown) => e instanceof SubmissionError && e.state === "uncertain";
  await assert.rejects(f.send(async () => {}), uncertain);
  await assert.rejects(f.send(async () => {}), uncertain);
  assert.equal(f.count(), 1);
  f.confirm();
  const signature = await f.send(async () => {});
  assert.equal(signature, (readSubmissionStorage(f.key) as { signature: string }).signature);
  assert.equal(f.count(), 1);
});

test("poll claims rotate through more than twenty open cash-outs, including failed requests", async () => {
  const now = Date.now();
  const rows = Array.from({ length: 25 }, (_, i) => ({ _id: String(i), status: "awaiting_funds", nextCheckAt: now - 1000 + i }));
  const ctx = { db: {
    query: () => ({ withIndex: () => ({ take: async (n: number) => rows.filter((r) => r.nextCheckAt <= Date.now()).sort((a, b) => a.nextCheckAt - b.nextCheckAt).slice(0, n).map((r) => ({ ...r })) }) }),
    patch: async (id: string, patch: { nextCheckAt: number }) => { Object.assign(rows.find((r) => r._id === id)!, patch); },
  } };
  const claim = (claimPollBatch as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<{ _id: string }[]> })._handler;
  assert.equal((await claim(ctx, {})).length, 20);
  // No status updates: the first batch may all have hit provider errors.
  assert.deepEqual((await claim(ctx, {})).map((r) => r._id), ["20", "21", "22", "23", "24"]);
});
