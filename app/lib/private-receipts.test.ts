import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, listReceipts, newReceipt, reconcile, saveReceipt } from "./private/receipts";

const status = (map: Record<string, { err?: unknown; confirmationStatus?: string } | null>) => ({
  getSignatureStatuses: async (sigs: string[]) => ({ context: { slot: 0 }, value: sigs.map((s) => map[s] ?? null) }),
});

test("an ER action is executed, not settled", async () => {
  const r = advance(newReceipt("post message", "er"), { erSignature: "er1" });
  const out = await reconcile(r, status({ er1: { confirmationStatus: "confirmed" } }) as never, status({}) as never);
  assert.equal(out.stage, "executed");
});

test("a commit stays settling until Solana confirms it", async () => {
  const r = advance(newReceipt("withdraw", "er"), { erSignature: "er1", commitId: "c1", baseSignature: "b1" });
  const er = status({ er1: { confirmationStatus: "confirmed" } }) as never;
  const pending = await reconcile(r, er, status({}) as never);
  assert.equal(pending.stage, "settling");
  const done = await reconcile(pending, er, status({ b1: { confirmationStatus: "finalized" } }) as never);
  assert.equal(done.stage, "settled");
});

test("unknown status leaves the receipt submitted", async () => {
  const r = advance(newReceipt("invite", "er"), { erSignature: "er1" });
  assert.equal((await reconcile(r, status({}) as never, status({}) as never)).stage, "submitted");
});

test("open receipts are never dropped to make room", () => {
  const wallet = "w1";
  const open = advance(newReceipt("deposit", "base"), { baseSignature: "b0" });
  saveReceipt(wallet, open);
  for (let i = 0; i < 60; i++) saveReceipt(wallet, advance(newReceipt(`m${i}`, "er"), { stage: "executed" }));
  assert.ok(listReceipts(wallet).some((r) => r.id === open.id));
});
