// Runs in its own process (node --test isolates files), so the flag is set before any module reads it.
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction, type Connection } from "@solana/web3.js";

const MINT = Keypair.generate().publicKey.toBase58();
process.env.NEXT_PUBLIC_JITOSOL_ENABLED = "1";
process.env.NEXT_PUBLIC_JITOSOL_MINT = MINT;
process.env.NEXT_PUBLIC_V2_LIVE = "1";

test("with the flag and mint set, jitoSOL (test) is selectable with its own feed, decimals and caps", async () => {
  const c = await import("../models/collateral");
  const { capabilityFor } = await import("../capabilities");
  const { validateRiskStep, parseDraft } = await import("../offer-validation");
  assert.deepEqual(c.selectableCollateral().map((a) => a.label), ["wSOL", "jitoSOL (test)"]);
  const jito = c.draftCollateral(MINT)!;
  assert.equal(jito.label, "jitoSOL (test)");
  assert.equal(jito.feedIdHex, "67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb");
  assert.deepEqual([jito.decimals, jito.maxLtvBps, jito.liquidationLtvBps], [9, 6_000, 7_000]);
  assert.equal(capabilityFor("zenlo-public", "devnet", MINT, "originate").available, true);

  // The wizard enforces the asset's caps, not wSOL's.
  const over = validateRiskStep({ collateral: "1", maxLtvBps: 7_000, liquidationLtvBps: 8_000, collateralMint: MINT });
  assert.ok(over.maxLtvBps && over.liquidationLtvBps);
  assert.deepEqual(validateRiskStep({ collateral: "1", maxLtvBps: 6_000, liquidationLtvBps: 7_000, collateralMint: MINT }), {});
  const parsed = parseDraft({ principal: "100", interestBps: 500, durationSeconds: 86_400, collateral: "1.5", maxLtvBps: 6_000, liquidationLtvBps: 7_000, collateralMint: MINT });
  assert.equal(parsed?.collateralAmount, 1_500_000_000n);
});

test("priced jitoSOL paths read the JITOSOL/USD account and fetch that feed before anything is simulated", async () => {
  const { collateralPriceAccount, feedPriceAccount, submitCollateralTx } = await import("./collateral-accounts");
  const { PYTH_PRICE_UPDATE_ACCOUNT } = await import("../constants");
  const { JITOSOL_USD_FEED_ID_HEX } = await import("../models/collateral");
  assert.ok(collateralPriceAccount(MINT, PYTH_PRICE_UPDATE_ACCOUNT).equals(feedPriceAccount(JITOSOL_USD_FEED_ID_HEX)));

  let simulated = 0;
  const connection = { simulateTransaction: async () => (simulated++, { value: { err: "x" } }) } as unknown as Connection;
  const asked: string[] = [];
  await assert.rejects(
    submitCollateralTx(connection, Keypair.generate() as never, MINT, new Transaction(), async (feed) => {
      asked.push(feed);
      throw new Error("no network in tests");
    }),
    /no network in tests/,
  );
  assert.deepEqual(asked, ["jitosol"]);
  assert.equal(simulated, 0);
});

test("the SOL-priced reference liquidator leaves jitoSOL loans alone", async () => {
  const { decide, DEFAULT_KEEPER_LIMITS } = await import("./keeper");
  const o = { status: "active", wsolMint: MINT } as never;
  assert.deepEqual(decide(o, null, 0, DEFAULT_KEEPER_LIMITS, 0n, 0n), { act: false, reason: "unsupported-collateral" });
});
