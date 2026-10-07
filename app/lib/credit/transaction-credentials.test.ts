import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";

const k = () => Keypair.generate().publicKey;
process.env.NEXT_PUBLIC_ARCIUM_ENABLED = "1";
process.env.NEXT_PUBLIC_SAS_CREDENTIAL = k().toBase58();
process.env.NEXT_PUBLIC_SAS_SCHEMA = k().toBase58();

const now = Math.floor(Date.now() / 1000);

test("real credit transaction builders select a valid Arcium result and retain the config accounts", async () => {
  const a = await import("./arcium");
  const { configV2Pda, creditConfigPda } = await import("./chain");
  const { DEVNET_GENESIS_HASH, DEVNET_USDC_MINT, NATIVE_WSOL_MINT, PYTH_PRICE_UPDATE_ACCOUNT } = await import("../constants");
  const { PROGRAM_V2_ID } = await import("../v2/program");
  const { sendAcceptOfferV2, sendCreateRequestV2, sendFundRequestV2 } = await import("../v2/transactions");
  const { EarlyRepayment } = await import("../loan-math-v2");
  const borrower = Keypair.generate();
  const result = Buffer.alloc(a.TIER_RESULT_LEN);
  a.TIER_RESULT_DISCRIMINATOR.copy(result); result[8] = 1;
  borrower.publicKey.toBuffer().copy(result, 9); result[41] = 3;
  result.writeBigInt64LE(BigInt(now), 50); result.writeBigInt64LE(BigInt(now), 66);
  result.writeBigInt64LE(BigInt(now + 86400), 74);
  const seen: VersionedTransaction[] = [];
  const connection = {
    getAccountInfo: async (key: PublicKey) => key.equals(a.tierResultPda(borrower.publicKey)) ? { owner: a.CREDIT_MXE_ID, data: result } : null,
    getGenesisHash: async () => DEVNET_GENESIS_HASH,
    getLatestBlockhash: async () => ({ blockhash: k().toBase58(), lastValidBlockHeight: 1 }),
    simulateTransaction: async (tx: VersionedTransaction) => { seen.push(tx); return { value: { err: "recorded", logs: [] } }; },
  } as unknown as Connection;
  const terms = { principal: 100_000_000n, interestBps: 500, duration: 30 * 86400, earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 2500, graceSeconds: 86400, lateFeeBps: 100, annualCeilingBps: 10000, collateralAmount: 1_000_000_000n, maxLtvBps: 8800, liquidationLtvBps: 9300 };
  const offer = { publicKey: k().toBase58(), originLender: k().toBase58(), borrower: borrower.publicKey.toBase58(), usdcMint: DEVNET_USDC_MINT.toBase58(), wsolMint: NATIVE_WSOL_MINT.toBase58(), maxLtvBps: 8800, liquidationLtvBps: 9300 };
  await assert.rejects(sendAcceptOfferV2(borrower, offer as never, PYTH_PRICE_UPDATE_ACCOUNT, connection));
  await assert.rejects(sendCreateRequestV2(borrower, 1n, terms, connection));
  await assert.rejects(sendFundRequestV2(Keypair.generate(), offer as never, 2n, PYTH_PRICE_UPDATE_ACCOUNT, connection));
  assert.equal(seen.length, 3);
  for (const tx of seen) {
    const keys = tx.message.staticAccountKeys;
    const ix = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex].equals(PROGRAM_V2_ID))!;
    assert.deepEqual(ix.accountKeyIndexes.slice(-3).map((i) => keys[i].toBase58()), [configV2Pda(), creditConfigPda(), a.tierResultPda(borrower.publicKey)].map((key) => key.toBase58()));
  }
});

test("expired, foreign, insufficient or absent Arcium results use the borrower's SAS credential", async () => {
  const a = await import("./arcium");
  const { selectCreditAccounts } = await import("./chain");
  const { attestationPda, CREDIT_CREDENTIAL, CREDIT_SCHEMA } = await import("./sas");
  const borrower = k();
  const data = Buffer.alloc(a.TIER_RESULT_LEN);
  a.TIER_RESULT_DISCRIMINATOR.copy(data); data[8] = 1; borrower.toBuffer().copy(data, 9);
  data[41] = 1; data.writeBigInt64LE(BigInt(now), 50); data.writeBigInt64LE(BigInt(now), 66); data.writeBigInt64LE(BigInt(now + 10), 74);
  const expected = attestationPda(new PublicKey(CREDIT_CREDENTIAL), new PublicKey(CREDIT_SCHEMA), borrower);
  for (const [info, required, at] of [[null, 1, now], [{ owner: k(), data }, 1, now], [{ owner: a.CREDIT_MXE_ID, data }, 3, now], [{ owner: a.CREDIT_MXE_ID, data }, 1, now + 10]] as const) {
    const connection = { getAccountInfo: async () => info } as unknown as Connection;
    assert.ok((await selectCreditAccounts(connection, borrower, required, at))[2].pubkey.equals(expected));
  }
});
