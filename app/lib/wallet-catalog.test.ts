import test from "node:test";
import assert from "node:assert/strict";
import { walletBrand, walletUnavailableReason } from "./wallet-catalog";
test("wallet branding recognizes official names without attributing lookalikes", () => {
  assert.equal(walletBrand("Jupiter Mobile")?.id, "jupiter");
  assert.equal(walletBrand("MetaMask")?.id, "metamask");
  assert.equal(walletBrand("Phantom Wallet")?.id, "phantom");
  assert.equal(walletBrand("Fake Phantom"), undefined);
});
test("an unconnected standard adapter uses declared capabilities, not absent account signing methods", () => {
  const wallet = {
    chains: ["solana:devnet"],
    features: { "solana:signTransaction": {} },
  };
  assert.equal(walletUnavailableReason({ wallet }, "devnet"), null);
  assert.equal(
    walletUnavailableReason(
      { wallet: { ...wallet, chains: ["solana:mainnet"] } },
      "devnet"
    ),
    "Devnet unavailable"
  );
  assert.equal(
    walletUnavailableReason(
      {
        wallet: {
          ...wallet,
          features: { "solana:signAndSendTransaction": {} },
        },
      },
      "devnet"
    ),
    "Solana signing unavailable"
  );
  assert.equal(
    walletUnavailableReason({}, "devnet"),
    "Solana signing unavailable"
  );
  assert.equal(
    walletUnavailableReason({ signTransaction: () => {} }, "localnet"),
    null
  );
});
