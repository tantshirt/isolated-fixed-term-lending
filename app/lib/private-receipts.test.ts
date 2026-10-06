import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, listReceipts, newReceipt, reconcile, recordSignedReceipt, saveReceipt } from "./private/receipts";

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


test("a signed receipt survives an uncertain broadcast and reconciles without another send", async () => {
  for (const environment of ["base", "er"] as const) {
    const wallet = `uncertain-${environment}`;
    const r = newReceipt("Transfer", environment);
    const signature = recordSignedReceipt(wallet, r, { signature: Buffer.alloc(64, 7) });
    // A transport error after submission cannot erase the signature saved before it.
    const saved = listReceipts(wallet).find((item) => item.id === r.id)!;
    assert.equal(saved.stage, "submitted");
    assert.equal(environment === "er" ? saved.erSignature : saved.baseSignature, signature);
    const source = status({ [signature]: { confirmationStatus: "confirmed" } }) as never;
    assert.equal((await reconcile(saved, source, source)).stage, environment === "er" ? "executed" : "settled");
  }
});

test("unsigned actions cannot create a misleading submission receipt", () => {
  assert.throws(() => recordSignedReceipt("unsigned", newReceipt("transfer", "er"), { signature: null }), /not signed/);
  assert.equal(listReceipts("unsigned").length, 0);
});


test("missing confirmation level remains unknown and failed settlement remains failed", async () => {
  const r = advance(newReceipt("move balance", "er"), { erSignature: "e", baseSignature: "b", commitId: "c" });
  assert.equal((await reconcile(r, status({ e: {} }) as never, status({}) as never)).stage, "submitted");
  const failed = await reconcile(advance(r, { stage: "settling" }), status({}) as never, status({ b: { err: { InstructionError: [0, "failure"] }, confirmationStatus: "confirmed" } }) as never);
  assert.equal(failed.stage, "failed");
});


test("a lost commit response remains settling after ER confirmation", async () => {
  const wallet = "commit-recovery";
  const receipt = newReceipt("Move to Solana", "er");
  const signature = recordSignedReceipt(wallet, receipt, { signature: Buffer.alloc(64, 8) }, true);
  const saved = listReceipts(wallet)[0];
  assert.equal(saved.commitId, signature);
  const source = status({ [signature]: { confirmationStatus: "confirmed" } }) as never;
  assert.equal((await reconcile(saved, source, status({}) as never)).stage, "settling");
});
