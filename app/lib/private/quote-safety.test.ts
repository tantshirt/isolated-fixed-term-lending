import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { verifyQuoteAction } from "./quote-safety";
import type { Quote, Ticket } from "./liquidation";
const wallet = Keypair.generate().publicKey;
const q: Quote = { address: Keypair.generate().publicKey, revision: 2, debt: 105000000n, payout: 1000000000n, expiresAt: 100, state: "open", tickets: [] };
const ticket: Ticket = { liquidator: wallet, revision: 2, paidIn: q.debt, minPayout: q.payout, payout: 0n, state: "funded" };
test("quote funding needs a matching, open, unexpired fresh quote", () => {
  assert.equal(verifyQuoteAction(q, q, wallet, true, 99), q);
  for (const changed of [undefined, { ...q, revision: 3 }, { ...q, debt: 1n }, { ...q, payout: 1n }, { ...q, state: "executed" as const }, { ...q, tickets: [ticket, ticket, ticket, ticket] }]) assert.throws(() => verifyQuoteAction(q, changed, wallet, true, 99));
  assert.throws(() => verifyQuoteAction(q, q, wallet, true, 100));
});
test("ticket collection requires this wallet and a collectible state", () => {
  const pending = { ...q, tickets: [ticket] };
  assert.throws(() => verifyQuoteAction(q, pending, wallet, false, 99));
  assert.throws(() => verifyQuoteAction(q, pending, wallet, false, 100));
  assert.equal(verifyQuoteAction(q, pending, wallet, false, 101), pending);
  const afterPaid = { ...q, tickets: [{ ...ticket, state: "paid" as const }, ticket] };
  assert.equal(verifyQuoteAction(q, afterPaid, wallet, false, 101), afterPaid);
  assert.throws(() => verifyQuoteAction(q, pending, Keypair.generate().publicKey, false, 100));
  assert.throws(() => verifyQuoteAction(q, { ...q, tickets: [{ ...ticket, state: "paid" }] }, wallet, false, 100));
  const won = { ...q, tickets: [{ ...ticket, state: "won" as const }] };
  assert.equal(verifyQuoteAction(q, won, wallet, false, 99), won);
});
