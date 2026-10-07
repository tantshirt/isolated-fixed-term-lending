import test from "node:test";
import assert from "node:assert/strict";
import { draftReceipt, type DraftReceipt } from "./draft-receipt";
import { COLLATERAL_ASSETS } from "./models/collateral";
import { DEFAULT_RULES } from "./v2/rules";

test("jitoSOL confirmation retains submitted terms, label and price after the draft resets", () => {
  const submitted: DraftReceipt = {
    draft: { principal: "123", interestBps: 500, durationSeconds: 86400, collateral: "2", maxLtvBps: 6000, liquidationLtvBps: 7000, collateralMint: "jito-test", collateralMode: "manual", cushion: 10, rules: { ...DEFAULT_RULES } },
    asset: { ...COLLATERAL_ASSETS.find((a) => a.symbol === "jitoSOL")!, mint: "jito-test" },
    owed: 129_150_000n,
    price: { price: 20_000_000_000n, conf: 1n, exponent: -8, publishTime: 100, fresh: true, chainTime: 100, receivedAt: 100000 },
  };
  const receipt = draftReceipt(submitted);
  submitted.draft.principal = "100";
  submitted.draft.collateralMint = undefined;
  submitted.draft.rules.graceSeconds = 0;
  submitted.asset.label = "wSOL";
  submitted.price!.price = 15_000_000_000n;
  assert.equal(receipt.draft.principal, "123");
  assert.equal(receipt.draft.collateralMint, "jito-test");
  assert.equal(receipt.asset.symbol, "jitoSOL");
  assert.notEqual(receipt.asset.label, "wSOL");
  assert.equal(receipt.price!.price, 20_000_000_000n);
  assert.equal(receipt.owed, 129_150_000n);
});
