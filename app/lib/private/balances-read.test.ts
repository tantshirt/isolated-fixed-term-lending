import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection, PublicKey } from "@solana/web3.js";
import { readPrivateBalance } from "./balances";
import { DELEGATION_PROGRAM_ID, ata, eataPda } from "./espl";

const owner = PublicKey.unique();
const mint = PublicKey.unique();
const custody = eataPda(owner, mint);
const walletAta = ata(owner, mint);
const base = (walletExists = false) => ({
  getAccountInfo: async (key: PublicKey) => key.equals(custody) ? { owner: DELEGATION_PROGRAM_ID, data: Buffer.alloc(80) } : key.equals(walletAta) && walletExists ? { data: Buffer.alloc(165) } : null,
  getMinimumBalanceForRentExemption: async () => 100,
  getTokenAccountBalance: async () => { throw new Error("Wallet RPC failed"); },
}) as unknown as Connection;

test("missing token account is zero but failed wallet or private reads stay unavailable", async () => {
  const er = { getAccountInfo: async () => ({ data: Buffer.alloc(165) }), getTokenAccountBalance: async () => { throw new Error("Private RPC failed"); } } as unknown as Connection;
  await assert.rejects(readPrivateBalance(base(), er, owner, mint), /Private RPC failed/);
  await assert.rejects(readPrivateBalance(base(true), null, owner, mint), /Wallet RPC failed/);
  const absent = await readPrivateBalance(base(), null, owner, mint);
  assert.equal(absent.walletAmount, 0n);
  assert.equal(absent.privateAmount, null);
});
