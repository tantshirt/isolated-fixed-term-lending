import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import idl from "@/idl/isolated_loan_v2.json";
import { DEVNET_GENESIS_HASH, NATIVE_WSOL_MINT, PYTH_PRICE_UPDATE_ACCOUNT, PYTH_PUSH_PROGRAM_ID, SOL_USD_FEED_ID_HEX } from "../constants";
import { collateralValueUsdc } from "../loan-math";
import { EarlyRepayment } from "../loan-math-v2";
import { COLLATERAL_ASSETS, JITOSOL_USD_FEED_ID_HEX, collateralForMint, collateralValueAtoms, draftCollateral, selectableCollateral, switchCollateral } from "../models/collateral";
import { validateRiskStep } from "../offer-validation";
import { collateralConfigPda, collateralPriceAccount, collateralRemainingAccounts, feedPriceAccount, needsCollateralConfig } from "./collateral-accounts";
import type { OfferV2, RequestV2 } from "./offers";
import { PROGRAM_V2_ID, getProgramV2 } from "./program";
import { sendAcceptOfferV2, sendFundRequestV2, sendLenderClaimV2, sendLiquidateV2 } from "./transactions";

const k = () => Keypair.generate().publicKey;

test("CollateralConfig PDA is [\"collateral\", mint] under isolated_loan_v2", () => {
  const mint = k();
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from("collateral"), mint.toBuffer()], PROGRAM_V2_ID);
  assert.ok(collateralConfigPda(mint).equals(expected));
  assert.ok(collateralConfigPda(mint.toBase58()).equals(expected));
  // Seeds name the mint: a different mint gives a different config.
  assert.ok(!collateralConfigPda(k()).equals(expected));
  // The IDL agrees on the seed bytes.
  const ix = (idl as { instructions: { name: string; accounts: { name: string; pda?: { seeds: { kind: string; value?: number[] }[] } }[] }[] }).instructions.find((i) => i.name === "set_collateral_config")!;
  const seed = ix.accounts.find((a) => a.name === "collateral_config")!.pda!.seeds[0];
  assert.equal(Buffer.from(seed.value!).toString(), "collateral");
});

test("wSOL passes no remaining account; any other mint passes its config first, read-only", () => {
  assert.deepEqual(collateralRemainingAccounts(NATIVE_WSOL_MINT), []);
  assert.equal(needsCollateralConfig(NATIVE_WSOL_MINT), false);
  const mint = k();
  const metas = collateralRemainingAccounts(mint);
  assert.equal(metas.length, 1);
  assert.ok(metas[0].pubkey.equals(collateralConfigPda(mint)));
  assert.equal(metas[0].isSigner, false);
  assert.equal(metas[0].isWritable, false);
});

test("jitoSOL reads its own JITOSOL/USD push-feed account, never SOL/USD", () => {
  assert.ok(feedPriceAccount(SOL_USD_FEED_ID_HEX).equals(PYTH_PRICE_UPDATE_ACCOUNT));
  const jito = feedPriceAccount(JITOSOL_USD_FEED_ID_HEX);
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from([0, 0]), Buffer.from(JITOSOL_USD_FEED_ID_HEX, "hex")], PYTH_PUSH_PROGRAM_ID);
  assert.ok(jito.equals(expected));
  assert.ok(!jito.equals(PYTH_PRICE_UPDATE_ACCOUNT));
  // wSOL keeps whatever SOL/USD account the caller passes.
  const custom = k();
  assert.ok(collateralPriceAccount(NATIVE_WSOL_MINT, custom).equals(custom));
});

test("the config lands right after the named accounts on every resolving instruction", async () => {
  const program = getProgramV2(Keypair.generate());
  const mint = k();
  const names = ["createOffer", "createRequest", "acceptOffer", "fundRequest", "liquidate", "liquidateOverdue", "claimPricedRecovery"] as const;
  const terms = {
    principal: new BN(1), interestBps: 0, duration: new BN(60), earlyRepayment: 0, minInterestBps: 0, graceSeconds: new BN(0), lateFeeBps: 0,
    annualCeilingBps: 0, collateralAmount: new BN(1), maxLtvBps: 1, liquidationLtvBps: 1,
  };
  const argsFor: Record<(typeof names)[number], unknown[]> = {
    createOffer: [new BN(1), terms, PublicKey.default],
    createRequest: [new BN(1), terms],
    acceptOffer: [],
    fundRequest: [new BN(1)],
    liquidate: [],
    liquidateOverdue: [],
    claimPricedRecovery: [],
  };
  for (const name of names) {
    const def = (idl as { instructions: { name: string; accounts: { name: string }[] }[] }).instructions.find(
      (i) => i.name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()) === name,
    )!;
    const accounts = Object.fromEntries(def.accounts.map((a) => [a.name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()), k()]));
    const ix = await (program.methods as Record<string, (...a: unknown[]) => { accountsStrict: (a: unknown) => { remainingAccounts: (m: unknown) => { instruction: () => Promise<{ keys: { pubkey: PublicKey }[] }> } } }>)
      [name](...argsFor[name])
      .accountsStrict(accounts)
      .remainingAccounts(collateralRemainingAccounts(mint))
      .instruction();
    assert.equal(ix.keys.length, def.accounts.length + 1, name);
    assert.ok(ix.keys[def.accounts.length].pubkey.equals(collateralConfigPda(mint)), name);
  }
});

/** A connection that records the simulated transaction and then fails it, so nothing is signed. */
function recorder() {
  const seen: VersionedTransaction[] = [];
  const connection = {
    getGenesisHash: async () => DEVNET_GENESIS_HASH,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    simulateTransaction: async (tx: VersionedTransaction) => {
      seen.push(tx);
      return { value: { err: "recorded", logs: [] } };
    },
    getAccountInfo: async () => null,
  } as unknown as Connection;
  return { connection, seen };
}

const terms = { principal: 100_000_000n, interestBps: 500, duration: 86_400, startTs: 1_800_000_000, earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 2_500, graceSeconds: 86_400, lateFeeBps: 100, annualCeilingBps: 10_000 };

function offer(wsolMint: PublicKey): OfferV2 {
  return {
    publicKey: k().toBase58(), originLender: k().toBase58(), currentLender: k().toBase58(), borrower: k().toBase58(), restrictedBorrower: null, offerId: 1n,
    usdcMint: k().toBase58(), wsolMint: wsolMint.toBase58(), terms, collateralRequired: 1n, collateralLocked: 1n, maxLtvBps: 6_000, liquidationLtvBps: 7_000,
    status: "active",
  } as unknown as OfferV2;
}

/** The program instruction (last in the transaction) and its trailing remaining accounts. */
function programIx(tx: VersionedTransaction) {
  const keys = tx.message.staticAccountKeys;
  const ix = tx.message.compiledInstructions.at(-1)!;
  assert.ok(keys[ix.programIdIndex].equals(PROGRAM_V2_ID));
  return ix.accountKeyIndexes.map((i) => keys[i]);
}

test("transactions pass the config as the last account on priced paths for non-wSOL collateral, and nothing for wSOL", async () => {
  const signer = Keypair.generate();
  for (const mint of [NATIVE_WSOL_MINT, k()]) {
    const { connection, seen } = recorder();
    const o = offer(mint);
    const r = { publicKey: k().toBase58(), borrower: k().toBase58(), usdcMint: k().toBase58(), wsolMint: mint.toBase58() } as unknown as RequestV2;
    await assert.rejects(sendAcceptOfferV2(signer, o, PYTH_PRICE_UPDATE_ACCOUNT, connection));
    await assert.rejects(sendLiquidateV2(signer, o, false, PYTH_PRICE_UPDATE_ACCOUNT, connection));
    await assert.rejects(sendLiquidateV2(signer, o, true, PYTH_PRICE_UPDATE_ACCOUNT, connection));
    await assert.rejects(sendLenderClaimV2(signer, o, false, PYTH_PRICE_UPDATE_ACCOUNT, connection));
    await assert.rejects(sendLenderClaimV2(signer, o, true, PYTH_PRICE_UPDATE_ACCOUNT, connection));
    await assert.rejects(sendFundRequestV2(signer, r, 7n, PYTH_PRICE_UPDATE_ACCOUNT, connection));
    assert.equal(seen.length, 6);
    const wsol = mint.equals(NATIVE_WSOL_MINT);
    seen.forEach((tx, i) => {
      const accounts = programIx(tx);
      const hasConfig = accounts.at(-1)!.equals(collateralConfigPda(mint));
      // The terminal claim (index 4) reads no price and needs no config.
      assert.equal(hasConfig, !wsol && i !== 4, `tx ${i} for ${wsol ? "wSOL" : "other"}`);
    });
  }
});

test("valuation matches loan_core::collateral_value_usdc_decimals", () => {
  // research.md § Per-asset collateral and math.rs `jitosol_vectors`.
  assert.equal(collateralValueAtoms(1_000_000_000n, 9, 18_000_000_000n, 18_000_000n, -8), 179_820_000n);
  assert.equal(collateralValueAtoms(982_464_000n, 9, 18_000_000_000n, 18_000_000n, -8), 176_666_676n);
  assert.equal(collateralValueAtoms(2_000_000n, 6, 100_000_000n, 0n, -8), 2_000_000n);
  assert.throws(() => collateralValueAtoms(1n, 0, 100_000n, 0n, -3));
  // At 9 decimals it equals the week-1 SOL formula exactly, as `sol_path_matches` proves in Rust.
  for (const [amount, price, conf, exp] of [
    [1_000_000_000n, 15_000_000_000n, 15_000_000n, -8],
    [1_001_001_002n, 15_000_000_000n, 15_000_000n, -8],
    [1n, 15_000_000_000n, 15_000_000n, -8],
    [123_456_789_012n, 987_654_321n, 12_345n, -12],
    [5_000_000_000n, 150_123n, 1n, -3],
  ] as const)
    assert.equal(collateralValueAtoms(amount, 9, price, conf, exp), collateralValueUsdc(amount, price, conf, exp));
});

test("with the flag off jitoSOL is hidden from every new-loan path", () => {
  assert.deepEqual(selectableCollateral().map((a) => a.label), ["wSOL"]);
  const jito = COLLATERAL_ASSETS.find((a) => a.symbol === "jitoSOL")!;
  assert.equal(draftCollateral(jito.mint || "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"), null);
  assert.ok(validateRiskStep({ collateral: "1", maxLtvBps: 6_000, liquidationLtvBps: 7_000, collateralMint: k().toBase58() }).collateralMint);
  assert.deepEqual(validateRiskStep({ collateral: "1", maxLtvBps: 7_000, liquidationLtvBps: 8_000 }), {});
  // An unknown mint on an existing loan still reads as wSOL for labels and pricing.
  assert.equal(collateralForMint(k().toBase58()).symbol, "wSOL");
});

test("switching collateral clamps the limits inside the asset's caps", () => {
  const jitoCaps = { ...COLLATERAL_ASSETS[1], mint: k().toBase58() };
  assert.deepEqual(switchCollateral({ maxLtvBps: 7_000, liquidationLtvBps: 8_000 }, jitoCaps), { collateralMint: jitoCaps.mint, maxLtvBps: 6_000, liquidationLtvBps: 7_000 });
  assert.deepEqual(switchCollateral({ maxLtvBps: 5_000, liquidationLtvBps: 6_500 }, jitoCaps), { collateralMint: jitoCaps.mint, maxLtvBps: 5_000, liquidationLtvBps: 6_500 });
  assert.deepEqual(switchCollateral({ maxLtvBps: 6_000, liquidationLtvBps: 7_000 }, COLLATERAL_ASSETS[0]), { collateralMint: undefined, maxLtvBps: 6_000, liquidationLtvBps: 7_000 });
});
