import test from "node:test";
import assert from "node:assert/strict";
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DEVNET_USDC_MINT, NATIVE_WSOL_MINT, PROGRAM_ID } from "./constants";
import { readOnlyProgram, decodeOffer } from "./offers";
import { decodeRequest, toRequest } from "./requests";
import { requestPda, requestVaultPda, u64Le } from "./pda";
import type { RequestAccount } from "./program";

const connection = new Connection("http://127.0.0.1:8899");
const borrower = Keypair.generate().publicKey;

const account = (over: Partial<RequestAccount> = {}): RequestAccount => ({
  borrower,
  requestId: new BN(42),
  usdcMint: DEVNET_USDC_MINT,
  wsolMint: NATIVE_WSOL_MINT,
  principal: new BN(100_000_000),
  interestBps: 500,
  durationSeconds: new BN(604_800),
  collateralAmount: new BN(1_001_001_002),
  maxLtvBps: 7000,
  liquidationLtvBps: 8000,
  createdTs: new BN(1_700_000_000),
  status: { open: {} },
  lender: PublicKey.default,
  offer: PublicKey.default,
  bump: 255,
  ...over,
});

const encode = (a: RequestAccount) =>
  readOnlyProgram(connection).coder.accounts.encode("loanRequest", a);

test("request PDAs follow the program seeds", () => {
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from("request"), borrower.toBuffer(), u64Le(42n)],
    PROGRAM_ID
  );
  assert.ok(requestPda(borrower, 42n).equals(expected));
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("request-wsol"), expected.toBuffer()],
    PROGRAM_ID
  );
  assert.ok(requestVaultPda(expected).equals(vault));
});

test("an open request decodes with no lender or offer", async () => {
  const key = Keypair.generate().publicKey;
  const r = decodeRequest(connection, key, await encode(account()));
  assert.ok(r);
  assert.equal(r.status, "open");
  assert.equal(r.requestId, 42n);
  assert.equal(r.principal, 100_000_000n);
  assert.equal(r.lender, null);
  assert.equal(r.offer, null);
});

test("a funded request records its lender and offer", () => {
  const lender = Keypair.generate().publicKey;
  const offer = Keypair.generate().publicKey;
  const r = toRequest(PublicKey.default, account({ status: { funded: {} }, lender, offer }));
  assert.equal(r.status, "funded");
  assert.equal(r.lender, lender.toBase58());
  assert.equal(r.offer, offer.toBase58());
});

test("other mints and other layouts are ignored", async () => {
  const key = Keypair.generate().publicKey;
  const foreign = await encode(account({ usdcMint: Keypair.generate().publicKey }));
  assert.equal(decodeRequest(connection, key, foreign), null);
  // A request is not an offer, and garbage is neither.
  assert.equal(decodeOffer(connection, key, await encode(account())), null);
  assert.equal(decodeRequest(connection, key, Buffer.alloc(40)), null);
});
