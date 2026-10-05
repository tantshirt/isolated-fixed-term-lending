import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ata, deposit, withdraw } from "./private/espl";
import { ReviewMismatch, validateTransaction } from "./private/tx-validator";

const owner = Keypair.generate().publicKey;
const usdc = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const tx = (...ixs: Parameters<Transaction["add"]>) => {
  const t = new Transaction().add(...ixs);
  t.feePayer = owner;
  return t;
};

test("a reviewed deposit passes", () => {
  validateTransaction(tx(deposit(owner, usdc, 100_000n)), {
    feePayer: owner,
    transfers: [{ kind: "deposit", owner, mint: usdc, amount: 100_000n }],
  });
});

test("an amount different from the review is refused", () => {
  assert.throws(
    () =>
      validateTransaction(tx(deposit(owner, usdc, 100_001n)), {
        feePayer: owner,
        transfers: [{ kind: "deposit", owner, mint: usdc, amount: 100_000n }],
      }),
    ReviewMismatch,
  );
});

test("a withdrawal to another destination is refused", () => {
  const elsewhere = Keypair.generate().publicKey;
  assert.throws(
    () =>
      validateTransaction(tx(withdraw(owner, usdc, 5n)), {
        feePayer: owner,
        transfers: [{ kind: "withdraw", owner, mint: usdc, amount: 5n, destination: ata(elsewhere, usdc) }],
      }),
    ReviewMismatch,
  );
});

test("an unreviewed transfer, foreign program, or other fee payer is refused", () => {
  assert.throws(() => validateTransaction(tx(deposit(owner, usdc, 1n)), { feePayer: owner }), ReviewMismatch);
  const stranger = Keypair.generate().publicKey;
  const foreign = tx(SystemProgram.transfer({ fromPubkey: owner, toPubkey: stranger, lamports: 1 }));
  foreign.instructions[0].programId = Keypair.generate().publicKey;
  assert.throws(() => validateTransaction(foreign, { feePayer: owner }), ReviewMismatch);
  assert.throws(() => validateTransaction(tx(deposit(owner, usdc, 1n)), { feePayer: stranger }), ReviewMismatch);
});

test("a reviewed transfer that is missing is refused", () => {
  assert.throws(
    () => validateTransaction(tx(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })), { feePayer: owner, transfers: [{ kind: "deposit", owner, mint: usdc, amount: 1n }] }),
    ReviewMismatch,
  );
});

test("a private send must match the reviewed recipient and amount", async () => {
  const { createTransferCheckedInstruction, createTransferInstruction } = await import("@solana/spl-token");
  const to = Keypair.generate().publicKey;
  const send = (dest: PublicKey, amt: bigint) => tx(createTransferCheckedInstruction(ata(owner, usdc), usdc, ata(dest, usdc), owner, amt, 6));
  const review = { feePayer: owner, transfers: [{ kind: "send" as const, owner, mint: usdc, amount: 5n, destination: ata(to, usdc) }] };
  validateTransaction(send(to, 5n), review);
  assert.throws(() => validateTransaction(send(Keypair.generate().publicKey, 5n), review), ReviewMismatch);
  assert.throws(() => validateTransaction(send(to, 6n), review), ReviewMismatch);
  assert.throws(() => validateTransaction(tx(createTransferInstruction(ata(owner, usdc), ata(to, usdc), owner, 5n)), review), ReviewMismatch);
});
