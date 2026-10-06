import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { KeypairWallet } from "../keypair-wallet";
import { sendPrivately } from "./transfers";
import { listReceipts, reconcile } from "./receipts";

test("actual private sender records the signed transaction before a lost broadcast response", async () => {
  const signer = new KeypairWallet(Keypair.generate());
  let received = 0;
  const er = {
    getAccountInfo: async () => ({ data: Buffer.alloc(165) }),
    getLatestBlockhash: async () => ({ blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 100 }),
    sendRawTransaction: async (raw: Uint8Array) => {
      received++;
      const signed = Transaction.from(raw);
      assert.ok(signed.signature);
      assert.equal(listReceipts(signer.publicKey.toBase58()).length, 1, "recovery must exist before network receives it");
      throw new Error("Response lost after accepting the transaction");
    },
  } as unknown as Connection;
  await assert.rejects(sendPrivately(er, signer, PublicKey.unique(), 6, PublicKey.unique(), 123n), /Response lost/);
  const saved = listReceipts(signer.publicKey.toBase58())[0];
  assert.ok(saved.erSignature);
  const confirmation = { getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }) } as unknown as Connection;
  assert.equal((await reconcile(saved, confirmation, confirmation)).stage, "executed");
  assert.equal(received, 1);
});
