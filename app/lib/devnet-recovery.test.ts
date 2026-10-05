import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { DevnetLoanService } from "./devnet-loan-service";
import { KeypairWallet } from "./keypair-wallet";
import {
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  NATIVE_WSOL_MINT,
  NETWORK,
  PROGRAM_ID,
  PYTH_PRICE_UPDATE_ACCOUNT,
} from "./constants";
import {
  reconcileSubmission,
  submitTransaction,
  SubmissionError,
  type Pending,
} from "./transaction-lifecycle";
import { fetchAllOffers, fetchOfferByKey, supportedOfferMints } from "./offers";
import { getProgram } from "./program";
import type { OfferDraft } from "./offer-validation";
const draft: OfferDraft = {
  principal: "0.1",
  interestBps: 500,
  collateral: "0.01",
  durationSeconds: 60,
  maxLtvBps: 7000,
  liquidationLtvBps: 8000,
};
const config = {
  usdcMint: DEVNET_USDC_MINT.toBase58(),
  wsolMint: NATIVE_WSOL_MINT.toBase58(),
  priceUpdateAccount: PYTH_PRICE_UPDATE_ACCOUNT.toBase58(),
};
function browser(t: TestContext) {
  const stored = new Map<string, string>(),
    held = new Set<string>();
  const original = Object.fromEntries(
    ["window", "localStorage", "navigator"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ])
  );
  const install = () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => stored.set(k, v),
        removeItem: (k: string) => stored.delete(k),
      },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          request: async (
            k: string,
            _o: unknown,
            cb: (l: object | null) => Promise<unknown>
          ) => {
            if (held.has(k)) return cb(null);
            held.add(k);
            try {
              return await cb({});
            } finally {
              held.delete(k);
            }
          },
        },
      },
    });
  };
  install();
  t.after(() => {
    for (const k of Object.keys(original)) {
      const d = original[k];
      if (d) Object.defineProperty(globalThis, k, d);
      else Reflect.deleteProperty(globalThis, k);
    }
  });
  return { stored, held, reload: install };
}
function rpc(t: TestContext) {
  let sends = 0,
    status: { err: null; confirmationStatus: string } | null = {
      err: null,
      confirmationStatus: "processed",
    };
  t.mock.method(
    Connection.prototype,
    "getGenesisHash",
    async () => DEVNET_GENESIS_HASH
  );
  t.mock.method(Connection.prototype, "getLatestBlockhash", async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  }));
  t.mock.method(Connection.prototype, "simulateTransaction", async () => ({
    value: { err: null },
  }));
  t.mock.method(Connection.prototype, "sendRawTransaction", async () => {
    sends++;
    throw Error("RPC lost after broadcast");
  });
  t.mock.method(Connection.prototype, "getSignatureStatuses", async () => ({
    value: [status],
  }));
  return {
    sends: () => sends,
    confirm: () => {
      status = { err: null, confirmationStatus: "confirmed" };
    },
  };
}
test("actual create service reuses persisted ID and immutable terms after uncertain broadcast and reload", async (t) => {
  const env = browser(t),
    chain = rpc(t),
    wallet = new KeypairWallet(Keypair.generate());
  let sig: string | undefined;
  await assert.rejects(
    new DevnetLoanService(wallet, config).execute({ action: "create", draft }),
    (e: unknown) => {
      assert.ok(e instanceof SubmissionError);
      assert.equal(e.state, "uncertain");
      sig = e.signature;
      return true;
    }
  );
  const key = [...env.stored.keys()].find((k) =>
      k.startsWith("lendspan:create:")
    )!,
    record = JSON.parse(env.stored.get(key)!);
  env.reload();
  await assert.rejects(
    new DevnetLoanService(wallet, config).execute({
      action: "create",
      draft: { ...draft, principal: "0.2" },
    }),
    /original terms/
  );
  assert.equal(env.stored.get(key), JSON.stringify(record));
  chain.confirm();
  const result = await new DevnetLoanService(wallet, config).execute({
    action: "create",
    draft,
  });
  assert.equal(result.signature, sig);
  assert.ok("offerId" in result);
  assert.equal(result.offerId, record.offerId);
  assert.equal(chain.sends(), 1);
  assert.equal(env.stored.size, 0);
});
test("prebroadcast RPC failure does not permanently lock create terms", async (t) => {
  const env = browser(t);
  rpc(t);
  t.mock.method(Connection.prototype, "getLatestBlockhash", async () => {
    throw Error("offline before signing");
  });
  await assert.rejects(
    new DevnetLoanService(
      new KeypairWallet(Keypair.generate()),
      config
    ).execute({ action: "create", draft }),
    /offline/
  );
  assert.equal(env.stored.size, 0);
});
test("other-tab lock and missing coordination prevent overwrites and sends", async (t) => {
  const env = browser(t),
    chain = rpc(t),
    wallet = new KeypairWallet(Keypair.generate()),
    key = `tenor:pending:${NETWORK}:${PROGRAM_ID}:${wallet.publicKey}`;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: SystemProgram.programId,
      lamports: 1,
    })
  );
  env.held.add(key);
  env.stored.set(key, "other-tab-data");
  await assert.rejects(
    submitTransaction(
      new Connection("https://api.devnet.solana.com"),
      wallet,
      tx
    ),
    /Another tab/
  );
  assert.equal(env.stored.get(key), "other-tab-data");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
  await assert.rejects(
    submitTransaction(
      new Connection("https://api.devnet.solana.com"),
      wallet,
      tx
    ),
    /Web Locks/
  );
  assert.equal(chain.sends(), 0);
});
test("invalid stored pending records fail closed with recovery guidance", async (t) => {
  const env = browser(t),
    chain = rpc(t),
    wallet = new KeypairWallet(Keypair.generate()),
    key = `tenor:pending:${NETWORK}:${PROGRAM_ID}:${wallet.publicKey}`;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: SystemProgram.programId,
      lamports: 1,
    })
  );
  for (const raw of [
    "{",
    "null",
    "{}",
    JSON.stringify({
      signature: "fake",
      blockhash: "fake",
      lastValidBlockHeight: 100,
    }),
  ]) {
    env.stored.set(key, raw);
    await assert.rejects(
      submitTransaction(
        new Connection("https://api.devnet.solana.com"),
        wallet,
        tx
      ),
      /recovery/i
    );
    assert.equal(env.stored.get(key), raw);
  }
  assert.equal(chain.sends(), 0);
});
test("expiration requires absent status and strictly greater finalized height", async () => {
  const record: Pending = {
    signature: "recorded",
    blockhash: "recorded",
    lastValidBlockHeight: 100,
  };
  let height = 100,
    status: { err: null; confirmationStatus: string } | null = null;
  const c = {
    getSignatureStatuses: async () => ({ value: [status] }),
    getBlockHeight: async () => height,
  } as unknown as Connection;
  await assert.rejects(reconcileSubmission(c, record), /pending/);
  height = 101;
  assert.equal(await reconcileSubmission(c, record), "expired");
  status = { err: null, confirmationStatus: "processed" };
  await assert.rejects(reconcileSubmission(c, record), /pending/);
});
test("offer list filters arbitrary mints and direct reads reject them; local custom mints remain supported", async (t) => {
  const wallet = new KeypairWallet(Keypair.generate()),
    p = getProgram(wallet);
  const a = {
    lender: wallet.publicKey,
    borrower: PublicKey.default,
    offerId: new BN(1),
    usdcMint: DEVNET_USDC_MINT,
    wsolMint: NATIVE_WSOL_MINT,
    principal: new BN(100000),
    interestBps: 500,
    durationSeconds: new BN(60),
    collateralAmount: new BN(10000000),
    maxLtvBps: 7000,
    liquidationLtvBps: 8000,
    startTs: new BN(0),
    expiryTs: new BN(0),
    status: { open: {} },
    bump: 255,
  };
  const good = {
      data: await p.coder.accounts.encode("offer", a),
      owner: PROGRAM_ID,
      lamports: 1,
      executable: false,
      rentEpoch: 0,
    },
    other = { ...a, usdcMint: Keypair.generate().publicKey },
    bad = { ...good, data: await p.coder.accounts.encode("offer", other) };
  const goodKey = Keypair.generate().publicKey,
    badKey = Keypair.generate().publicKey;
  t.mock.method(Connection.prototype, "getProgramAccounts", async () => [
    { pubkey: goodKey, account: good },
    { pubkey: badKey, account: bad },
  ]);
  t.mock.method(Connection.prototype, "getAccountInfoAndContext", async () => ({
    context: { slot: 1 },
    value: bad,
  }));
  const c = new Connection("https://api.devnet.solana.com");
  assert.deepEqual(
    (await fetchAllOffers(c)).map((o) => o.publicKey),
    [goodKey.toBase58()]
  );
  await assert.rejects(fetchOfferByKey(c, badKey), /Unsupported offer/);
  assert.equal(supportedOfferMints(other, true), true);
});
function child(script: string, env: Record<string, string>) {
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `(async()=>{${script}})().catch(e=>{console.error(e);process.exitCode=1})`,
    ],
    { env: { ...process.env, ...env } }
  );
}
test("incompatible oracle override produces explicit config readiness error", () => {
  child(
    `const assert=require('node:assert/strict');const {readDevConfig}=require('./lib/server/dev-config');await assert.rejects(readDevConfig(),/Unsupported PYTH_PRICE_UPDATE_ACCOUNT/);const {GET}=require('./app/api/config/route');const r=await GET();assert.equal(r.status,503);const b=await r.json();assert.equal(b.config,null);assert.equal(b.readiness.ready,false);assert.match(b.readiness.errors[0],/shard 0/);`,
    {
      NEXT_PUBLIC_SOLANA_NETWORK: "devnet",
      PYTH_PRICE_UPDATE_ACCOUNT: SystemProgram.programId.toBase58(),
    }
  );
});
test("local keepFresh rejects public hosts and foreign origins before any RPC", () => {
  child(
    `const assert=require('node:assert/strict');const {Connection}=require('@solana/web3.js');Connection.prototype.getAccountInfo=async()=>{throw Error('RPC must not run')};const {GET}=require('./app/api/price/route');for(const r of [new Request('http://localhost:3000/api/price?keepFresh=1',{headers:{origin:'https://foreign.example'}}),new Request('https://public.example/api/price?keepFresh=1')])assert.equal((await GET(r)).status,403);`,
    {
      NEXT_PUBLIC_SOLANA_NETWORK: "localnet",
      NEXT_PUBLIC_SOLANA_RPC_URL: "http://127.0.0.1:8899",
      NODE_ENV: "development",
      ENABLE_LOCAL_CONTROLS: "true",
    }
  );
});
test("Devnet keepFresh is nonmutating and shared refresh target matches the SDK", () => {
  child(
    `const assert=require('node:assert/strict');const {Connection,Keypair}=require('@solana/web3.js');const k=require('./lib/constants');const {encodePriceUpdateV2}=require('./lib/server/price-update-codec');const {getPriceFeedAccountForProgram}=require('@pythnetwork/pyth-solana-receiver');assert.equal(getPriceFeedAccountForProgram(k.PYTH_PRICE_SHARD,k.SOL_USD_FEED_ID_HEX,k.PYTH_PUSH_PROGRAM_ID).toBase58(),k.PYTH_PRICE_UPDATE_ACCOUNT.toBase58());Connection.prototype.getAccountInfo=async()=>({owner:k.PYTH_RECEIVER_PROGRAM_ID,data:encodePriceUpdateV2(Keypair.generate().publicKey,{feedId:k.SOL_USD_FEED_ID,price:15000000000n,conf:15000000n,exponent:-8,publishTime:960n}),lamports:1});Connection.prototype.getSlot=async()=>1;Connection.prototype.getBlockTime=async()=>1000;const {GET}=require('./app/api/price/route');const r=await GET(new Request('https://public.example/api/price?keepFresh=1',{headers:{origin:'https://foreign.example'}}));assert.equal(r.status,200);assert.equal((await r.json()).publishTime,960);`,
    {
      NEXT_PUBLIC_SOLANA_NETWORK: "devnet",
      PYTH_PRICE_UPDATE_ACCOUNT: "",
      ENABLE_LOCAL_CONTROLS: "true",
    }
  );
});
