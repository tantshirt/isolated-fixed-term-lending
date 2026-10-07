import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { assertOriginationAllowed } from "./ops-transaction";
import { PROGRAM_ID } from "./constants";
import { PRIVATE_PROGRAM_ID } from "./private/room-codec";

const tx = (name: string, programId = PROGRAM_ID) => new Transaction().add(new TransactionInstruction({
  programId, keys: [], data: createHash("sha256").update(`global:${name}`).digest().subarray(0, 8),
}));
test("live origination and provider pauses stop public and private signing", async () => {
  for (const program of [PROGRAM_ID, PRIVATE_PROGRAM_ID, new PublicKey("8hxagcQkw1Km6PWZgpA92qUnqvnFufC7tx2jvxf9Ko8m"), new PublicKey("JAzy8NP6V8AGrAko8vfgrD44BDghN6eLwqB7vjuYhHNq")]) {
    for (const action of ["create_offer", "create_request", "accept_offer", "fund_request", "propose_terms", "fund_loan", "accept_loan"]) {
      await assert.rejects(assertOriginationAllowed(tx(action, program), async () => [{ key: "originations", paused: true, reason: "Maintenance" }]), /Maintenance/);
    }
  }
  await assert.rejects(assertOriginationAllowed(tx("fund_loan", PRIVATE_PROGRAM_ID), async () => [{ key: "provider:zenlo-private", paused: true }]), /paused/);
  await assertOriginationAllowed(tx("create_offer"), async () => [{ key: "originations", paused: false }]);
});
test("servicing and recovery stay available even if the backend is down", async () => {
  for (const name of ["repay", "add_collateral", "liquidate", "liquidate_overdue", "claim_terminal", "claim_priced_recovery", "cancel_offer", "close_offer", "withdraw", "remove_loan_reader"]) {
    await assertOriginationAllowed(tx(name), async () => { throw new Error("Backend down"); });
  }
});
