import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  Connection,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  NETWORK,
  DEVNET_GENESIS_HASH,
  RPC_URL,
  PYTH_RECEIVER_PROGRAM_ID,
  SOL_USD_FEED_ID,
} from "./constants";
import { rejectLocalRequest, localControlsEnabled } from "./server/local-guard";
import {
  encodePriceUpdateV2,
  decodePriceUpdateV2,
} from "./server/price-update-codec";
import { validatePriceAccount } from "./server/validate-price";
import { submitTransaction, SubmissionError } from "./transaction-lifecycle";
import { KeypairWallet } from "./keypair-wallet";

test("defaults are Devnet and public mutation requests are rejected", () => {
  assert.equal(NETWORK, "devnet");
  assert.equal(RPC_URL, "https://api.devnet.solana.com");
  assert.equal(
    rejectLocalRequest(
      new Request("https://tenor.example/api/setup", { method: "POST" })
    )?.status,
    403
  );
});
const message = {
  feedId: SOL_USD_FEED_ID,
  price: 15_000_000_000n,
  conf: 15_000_000n,
  exponent: -8,
  publishTime: 1000n,
};
test("Pyth rejects wrong owner/feed, stale/future price, excessive confidence and partial verification", () => {
  const data = encodePriceUpdateV2(Keypair.generate().publicKey, message);
  const decoded = decodePriceUpdateV2(data);
  validatePriceAccount(PYTH_RECEIVER_PROGRAM_ID, decoded, 1060);
  assert.throws(() =>
    validatePriceAccount(SystemProgram.programId, decoded, 1000)
  );
  assert.throws(() =>
    validatePriceAccount(
      PYTH_RECEIVER_PROGRAM_ID,
      { ...decoded, feedId: Buffer.alloc(32) },
      1000
    )
  );
  assert.throws(() =>
    validatePriceAccount(PYTH_RECEIVER_PROGRAM_ID, decoded, 1061)
  );
  assert.throws(() =>
    validatePriceAccount(PYTH_RECEIVER_PROGRAM_ID, decoded, 999)
  );
  assert.throws(() =>
    validatePriceAccount(
      PYTH_RECEIVER_PROGRAM_ID,
      { ...decoded, conf: 400_000_000n },
      1000
    )
  );
  data[40] = 0;
  assert.throws(() => decodePriceUpdateV2(data), /Full/);
});
function fixture() {
  const wallet = new KeypairWallet(Keypair.generate());
  let sent = 0,
    signed = 0;
  let confirmed = false;
  const signer = {
    publicKey: wallet.publicKey,
    signAllTransactions: wallet.signAllTransactions.bind(wallet),
    signTransaction: async <
      T extends Transaction | import("@solana/web3.js").VersionedTransaction
    >(
      tx: T
    ) => {
      signed++;
      return wallet.signTransaction(tx);
    },
  };
  const connection = {
    getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    simulateTransaction: async () => ({ value: { err: null } }),
    sendRawTransaction: async () => {
      sent++;
      throw new Error("RPC disconnected after broadcast");
    },
    getSignatureStatuses: async () => ({
      value: [
        confirmed ? { err: null, confirmationStatus: "confirmed" } : null,
      ],
    }),
    getBlockHeight: async () => 90,
  };
  const transaction = () =>
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: SystemProgram.programId,
        lamports: 1,
      })
    );
  return {
    signer,
    connection,
    transaction,
    counts: () => ({ sent, signed }),
    confirm: () => {
      confirmed = true;
    },
  };
}
test("an uncertain broadcast preserves signature and retry reconciles without signing twice", async () => {
  const f = fixture();
  let signature: string | undefined;
  await assert.rejects(
    submitTransaction(
      f.connection as unknown as Connection,
      f.signer,
      f.transaction()
    ),
    (error: unknown) => {
      assert.ok(error instanceof SubmissionError);
      assert.equal(error.state, "uncertain");
      signature = error.signature;
      return true;
    }
  );
  await assert.rejects(
    submitTransaction(
      f.connection as unknown as Connection,
      f.signer,
      f.transaction()
    ),
    /pending/
  );
  assert.deepEqual(f.counts(), { sent: 1, signed: 1 });
  f.confirm();
  assert.equal(
    await submitTransaction(
      f.connection as unknown as Connection,
      f.signer,
      f.transaction()
    ),
    signature
  );
  assert.deepEqual(f.counts(), { sent: 1, signed: 1 });
});
test("failed simulation prevents signing and broadcast", async () => {
  const f = fixture();
  f.connection.simulateTransaction = async () => ({
    value: { err: "invalid oracle" as never },
  });
  await assert.rejects(
    submitTransaction(
      f.connection as unknown as Connection,
      f.signer,
      f.transaction()
    ),
    /Simulation failed/
  );
  assert.deepEqual(f.counts(), { sent: 0, signed: 0 });
});

test("local controls require opt-in, loopback, localnet and nonproduction together", () => {
  const env = {
    NODE_ENV: "development",
    ENABLE_LOCAL_CONTROLS: "true",
  } as NodeJS.ProcessEnv;
  assert.equal(
    localControlsEnabled(env, "http://127.0.0.1:8899", "localnet"),
    true
  );
  assert.equal(
    localControlsEnabled(
      { ...env, NODE_ENV: "production" },
      "http://127.0.0.1:8899",
      "localnet"
    ),
    false
  );
  assert.equal(
    localControlsEnabled(env, "https://api.devnet.solana.com", "localnet"),
    false
  );
  assert.equal(
    localControlsEnabled(
      { ...env, ENABLE_LOCAL_CONTROLS: "false" },
      "http://localhost:8899",
      "localnet"
    ),
    false
  );
});
test("wallet rejection is distinct and never broadcasts", async () => {
  const f = fixture();
  f.signer.signTransaction = async () => {
    throw new Error("user rejected");
  };
  await assert.rejects(
    submitTransaction(
      f.connection as unknown as Connection,
      f.signer,
      f.transaction()
    ),
    (e: unknown) => e instanceof SubmissionError && e.state === "rejected"
  );
  assert.equal(f.counts().sent, 0);
});
test("confirmed chain failure retains signature and is not uncertain", async () => {
  const f = fixture();
  const connection = {
    ...f.connection,
    sendRawTransaction: async () => "signature",
    confirmTransaction: async () => ({
      value: { err: { InstructionError: [0, "InvalidAccountData"] } },
    }),
  };
  await assert.rejects(
    submitTransaction(
      connection as unknown as Connection,
      f.signer,
      f.transaction()
    ),
    (e: unknown) =>
      e instanceof SubmissionError &&
      e.state === "confirmed-failure" &&
      Boolean(e.signature)
  );
});

test("Devnet genesis constant matches the full live hash and rejects mainnet before signing", async () => {
  assert.equal(
    DEVNET_GENESIS_HASH,
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  );
  const f = fixture();
  f.connection.getGenesisHash = async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  await assert.rejects(
    submitTransaction(
      f.connection as unknown as Connection,
      f.signer,
      f.transaction()
    ),
    /not Solana Devnet/
  );
  assert.deepEqual(f.counts(), { sent: 0, signed: 0 });
});

test("explicit WebSocket endpoint is shared by read and program connections", () => {
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `
    const assert = require("node:assert/strict");
    const { getConnection, getProgram } = require("./lib/program.ts");
    const { Keypair } = require("@solana/web3.js");
    const expected = "wss://solana-devnet.api.onfinality.io/public-ws";
    assert.equal(getConnection()._rpcWsEndpoint, expected);
    assert.equal(getProgram(Keypair.generate()).provider.connection._rpcWsEndpoint, expected);
  `,
    ],
    {
      env: {
        ...process.env,
        NEXT_PUBLIC_SOLANA_WS_URL:
          "wss://solana-devnet.api.onfinality.io/public-ws",
      },
    }
  );
});
