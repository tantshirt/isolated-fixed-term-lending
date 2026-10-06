import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { assertSponsoredScenario } from "./lab";
import { PRIVATE_PROGRAM_ID } from "./room-codec";

const me = PublicKey.unique();
const sponsor = PublicKey.unique();
const rent = 1_000_000;
const expected = new TransactionInstruction({ programId: PRIVATE_PROGRAM_ID, keys: [{ pubkey: me, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) });
const transaction = () => new Transaction({ feePayer: sponsor }).add(SystemProgram.transfer({ fromPubkey: sponsor, toPubkey: me, lamports: rent + 500_000 }), expected);

test("sponsored first draw accepts the reviewed funding and exact instruction only", () => {
  assert.doesNotThrow(() => assertSponsoredScenario(transaction(), me, rent, expected));
  for (const mutate of [
    (tx: Transaction) => { tx.instructions[0] = SystemProgram.transfer({ fromPubkey: me, toPubkey: sponsor, lamports: rent + 500_000 }); },
    (tx: Transaction) => { tx.instructions[0] = SystemProgram.transfer({ fromPubkey: sponsor, toPubkey: me, lamports: rent + 1 }); },
    (tx: Transaction) => { tx.instructions[1] = new TransactionInstruction({ ...expected, data: Buffer.from([4, 5, 6]) }); },
    (tx: Transaction) => { tx.instructions[1] = new TransactionInstruction({ ...expected, keys: [{ pubkey: PublicKey.unique(), isSigner: true, isWritable: true }] }); },
    (tx: Transaction) => { tx.add(SystemProgram.transfer({ fromPubkey: me, toPubkey: sponsor, lamports: 1 })); },
  ]) {
    const tx = transaction(); mutate(tx);
    assert.throws(() => assertSponsoredScenario(tx, me, rent, expected), /nothing was signed/);
  }
});
