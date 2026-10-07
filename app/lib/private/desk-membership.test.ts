import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { assertMembershipTransactionFits, deskMembershipAccounts } from "./desk-membership";
import { permissionPda } from "./espl";
import { PRIVATE_V2_ID, v2Pda } from "./v2-codec";

const desk = new PublicKey(new Uint8Array(32).fill(17));
const payer = new PublicKey(new Uint8Array(32).fill(18));

test("membership supplies every policy and book permission in canonical order", () => {
  const accounts = deskMembershipAccounts(desk, { policyVersion: 2, nextLoanSeq: 3 });
  const records = [v2Pda.deskPolicy(desk, 1), v2Pda.deskPolicy(desk, 2), ...[0, 1, 2].map((i) => v2Pda.deskLoan(desk, i))];
  assert.equal(accounts.length, 10);
  records.forEach((record, i) => {
    assert.deepEqual(accounts[2 * i], { pubkey: record, isSigner: false, isWritable: false });
    assert.deepEqual(accounts[2 * i + 1], { pubkey: permissionPda(record), isSigner: false, isWritable: true });
  });
  assert.deepEqual(deskMembershipAccounts(desk, { policyVersion: 0, nextLoanSeq: 0 }), []);
});

test("membership transaction size is checked before signing and never silently split", () => {
  const instruction = (loans: number) => new TransactionInstruction({
    programId: PRIVATE_V2_ID,
    keys: [{ pubkey: payer, isSigner: true, isWritable: true }, ...deskMembershipAccounts(desk, { policyVersion: 1, nextLoanSeq: loans })],
    data: Buffer.alloc(41),
  });
  assert.doesNotThrow(() => assertMembershipTransactionFits(instruction(1), payer));
  assert.throws(() => assertMembershipTransactionFits(instruction(40), payer), /No membership or permissions were changed/);
});
