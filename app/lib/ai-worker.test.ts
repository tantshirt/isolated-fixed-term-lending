import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import idl from "../idl/private_loan.json";
import { disclosureHash, RESULT_MAX } from "./private/ai-codec";

test("AI worker claims exclusively before spending and never retries a consumed approval", async (t) => {
  const require = createRequire(import.meta.url);
  const moduleLoader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = moduleLoader._load;
  const originalWorker = process.env.PRIVATE_AI_WORKER_SECRET;
  const originalGateway = process.env.AI_GATEWAY_API_KEY;
  const originalModel = process.env.AI_GATEWAY_MODEL;
  const worker = Keypair.generate();
  process.env.PRIVATE_AI_WORKER_SECRET = JSON.stringify(Array.from(worker.secretKey));
  process.env.AI_GATEWAY_API_KEY = "offline-test-placeholder";
  process.env.AI_GATEWAY_MODEL = "test/offline";

  let modelCalls = 0;
  let failAttempts = 0;
  const events: string[] = [];
  moduleLoader._load = function (name, ...args) {
    if (name === "ai") return {
      Output: { object: (options: unknown) => options },
      generateText: async (options: { maxRetries: number; maxOutputTokens: number }) => {
        events.push("model");
        modelCalls++;
        assert.equal(options.maxRetries, 0);
        assert.equal(options.maxOutputTokens, 2000);
        if (modelCalls <= failAttempts) throw new Error("controlled model failure");
        return { output: { kind: "explanation", text: "An offline test answer." } };
      },
    };
    if (name === "@magicblock-labs/ephemeral-rollups-sdk") return {
      verifyTeeRpcIntegrity: async () => {},
      getAuthToken: async () => ({ token: "offline-token", expiresAt: Date.now() + 3_600_000 }),
    };
    return originalLoad.call(this, name, ...args);
  };

  t.mock.method(globalThis, "fetch", async () => { throw new Error("Network access is forbidden in this test"); });
  const room = Keypair.generate().publicKey;
  const requestId = new Uint8Array(32).fill(7);
  const excerpt = "An approved offline excerpt.";
  const record = Buffer.alloc(162 + RESULT_MAX);
  record[0] = 1;
  worker.publicKey.toBuffer().copy(record, 1);
  room.toBuffer().copy(record, 33);
  record[97] = 1;
  Buffer.from(await disclosureHash("test/offline", excerpt)).copy(record, 98);
  record.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 300), 142);
  const claimDisc = Buffer.from(idl.instructions.find((i) => i.name === "claim_ai_request")!.discriminator);
  const blockhash = Keypair.generate().publicKey.toBase58();
  let mode: "success" | "rejected" | "uncertain" = "success";
  const outcomes = new Map<string, { claim: boolean; error: unknown }>();
  const claimSignatures: string[] = [];
  let barrier: Promise<void> | undefined;
  let releaseBarrier: (() => void) | undefined;
  let reads = 0;
  t.mock.method(Connection.prototype, "getAccountInfo", async () => {
    const snapshot = Buffer.from(record);
    if (barrier) {
      if (++reads === 2) releaseBarrier!();
      await barrier;
    }
    return { data: snapshot, owner: new PublicKey(idl.address), executable: false, lamports: 1, rentEpoch: 0 };
  });
  t.mock.method(Connection.prototype, "getLatestBlockhash", async () => ({ blockhash, lastValidBlockHeight: 100 }));
  t.mock.method(Connection.prototype, "sendRawTransaction", async (bytes: Buffer) => {
    const tx = Transaction.from(bytes);
    assert.equal(tx.verifySignatures(), true);
    const claim = tx.instructions[0].data.subarray(0, 8).equals(claimDisc);
    const signature = utils.bytes.bs58.encode(tx.signature!);
    let error: unknown = null;
    if (claim) {
      claimSignatures.push(signature);
      error = mode === "rejected" || record[150] !== 0 ? { InstructionError: [0, "AlreadyClaimed"] } : null;
      if (!error) record[150] = 2;
      events.push("claim-send");
    } else {
      assert.equal(record[150], 2);
      record[150] = 1;
      events.push("callback-send");
    }
    outcomes.set(signature, { claim, error });
    return signature;
  });
  t.mock.method(Connection.prototype, "confirmTransaction", async (input: string | { signature: string }) => {
    const outcome = outcomes.get(typeof input === "string" ? input : input.signature)!;
    if (outcome.claim && mode === "uncertain") throw new Error("Claim confirmation is uncertain");
    events.push(outcome.claim ? "claim-confirm" : "callback-confirm");
    return { context: { slot: 1 }, value: { err: outcome.error } };
  });

  function reset(nextMode: typeof mode = "success", failures = 0) {
    mode = nextMode;
    failAttempts = failures;
    modelCalls = 0;
    record[150] = 0;
    outcomes.clear();
    events.length = 0;
    claimSignatures.length = 0;
    barrier = undefined;
    reads = 0;
  }

  try {
    // Only external transports are substituted; this executes the production
    // service, Anchor instruction builder, transaction signer and result codec.
    const { answerRequest } = require("./server/ai-worker") as typeof import("./server/ai-worker");
    await t.test("rejected and uncertain confirmations make no model calls", async () => {
      for (const state of ["rejected", "uncertain"] as const) {
        reset(state);
        await assert.rejects(answerRequest(room, requestId, excerpt));
        assert.equal(modelCalls, 0);
        assert.equal(claimSignatures.length, 1);
        assert.equal(events.includes("callback-send"), false);
      }
      await assert.rejects(answerRequest(room, requestId, excerpt), /already claimed/);
      assert.equal(modelCalls, 0);
    });
    await t.test("concurrent invocations produce distinct claims and only the winner spends", async () => {
      reset();
      barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
      const results = await Promise.allSettled([answerRequest(room, requestId, excerpt), answerRequest(room, requestId, excerpt)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      assert.equal(new Set(claimSignatures).size, 2);
      assert.equal(modelCalls, 1);
      assert.ok(events.indexOf("claim-confirm") < events.indexOf("model"));
    });
    await t.test("confirmed claim permits one bounded retry", async () => {
      reset("success", 1);
      const response = await answerRequest(room, requestId, excerpt);
      assert.equal(response.result.kind, "explanation");
      assert.equal(modelCalls, 2);
      assert.deepEqual(events, ["claim-send", "claim-confirm", "model", "model", "callback-send", "callback-confirm"]);
    });
    await t.test("two failed attempts consume the approval across invocations", async () => {
      reset("success", 100);
      await assert.rejects(answerRequest(room, requestId, excerpt), /controlled model failure/);
      assert.equal(modelCalls, 2);
      assert.equal(record[150], 2);
      await assert.rejects(answerRequest(room, requestId, excerpt), /already claimed/);
      assert.equal(modelCalls, 2);
      assert.equal(claimSignatures.length, 1);
    });
  } finally {
    moduleLoader._load = originalLoad;
    for (const [name, original] of [["PRIVATE_AI_WORKER_SECRET", originalWorker], ["AI_GATEWAY_API_KEY", originalGateway], ["AI_GATEWAY_MODEL", originalModel]] as const) {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  }
});
