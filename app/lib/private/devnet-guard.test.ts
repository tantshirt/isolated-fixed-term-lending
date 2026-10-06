import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { KeypairWallet } from "../keypair-wallet";
import { openRoom } from "./rooms";
import { proposeLoan } from "./loans";
import { publishCard, retractCard, SHOW } from "./discovery";

// Mainnet genesis: any connection that is not Devnet must stop before the wallet signs.
const notDevnet = () => {
  const calls: string[] = [];
  const conn = new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => async () => {
      calls.push(key);
      if (key === "getGenesisHash") return "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
      if (key === "getAccountInfo") return null;
      throw new Error(`unexpected RPC call ${key}`);
    },
  }) as unknown as Connection;
  return { conn, calls };
};

const signerThatMustNotSign = () => {
  const signer = new KeypairWallet(Keypair.generate());
  signer.signTransaction = async () => {
    throw new Error("wallet was asked to sign on a non-Devnet connection");
  };
  return signer;
};

const refused = /not Solana Devnet/;

test("opening a private room refuses a non-Devnet connection before signing", async () => {
  const { conn, calls } = notDevnet();
  await assert.rejects(openRoom(conn, conn, signerThatMustNotSign()), refused);
  assert.ok(!calls.includes("sendRawTransaction"));
});

test("setting up private loan custody refuses a non-Devnet connection before signing", async () => {
  const { conn, calls } = notDevnet();
  const terms = { principal: 1_000_000n, interestBps: 500, durationSeconds: 3600, collateral: 10_000_000n, maxLtvBps: 7000, liquidationLtvBps: 8000 };
  await assert.rejects(proposeLoan(conn, conn, signerThatMustNotSign(), PublicKey.unique(), terms as never), refused);
  assert.ok(!calls.includes("sendRawTransaction"));
});

test("publishing and retracting a request card refuse a non-Devnet connection", async () => {
  const { conn, calls } = notDevnet();
  const fields = { show: SHOW.amount, amountMin: 1n, amountMax: 2n, maxInterestBps: 500, durationSeconds: 3600, collateralNote: "" };
  await assert.rejects(publishCard(conn, conn, signerThatMustNotSign(), PublicKey.unique(), fields), refused);
  await assert.rejects(retractCard(conn, signerThatMustNotSign(), PublicKey.unique()), refused);
  assert.ok(!calls.includes("sendRawTransaction"));
});
