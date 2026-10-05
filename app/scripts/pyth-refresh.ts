// Posts a fresh, Full-verified SOL/USD update to the canonical shard-0 account
// on Devnet. Used by private-protocol scripts before acceptance and liquidation,
// because the sponsored Devnet feed is not refreshed often enough for a 60 s
// age limit. Lives in app/ so it resolves the app's Pyth receiver dependency.
import { Wallet } from "@coral-xyz/anchor";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { Connection, Keypair, sendAndConfirmTransaction } from "@solana/web3.js";
import { PYTH_PRICE_SHARD, PYTH_PUSH_PROGRAM_ID, PYTH_RECEIVER_PROGRAM_ID, SOL_USD_FEED_ID_HEX } from "../lib/constants";

export async function refreshPyth(connection: Connection, payer: Keypair): Promise<string[]> {
  const url = new URL("/v2/updates/price/latest", process.env.PYTH_HERMES_URL || "https://hermes.pyth.network");
  url.searchParams.append("ids[]", SOL_USD_FEED_ID_HEX);
  url.searchParams.set("encoding", "base64");
  const headers: Record<string, string> = {};
  if (process.env.PYTH_HERMES_API_KEY) headers.Authorization = `Bearer ${process.env.PYTH_HERMES_API_KEY}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Hermes returned ${res.status}; set PYTH_HERMES_API_KEY.`);
  const body = await res.json();
  const receiver = new PythSolanaReceiver({
    connection,
    wallet: new Wallet(payer),
    receiverProgramId: PYTH_RECEIVER_PROGRAM_ID,
    pushOracleProgramId: PYTH_PUSH_PROGRAM_ID,
  });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addUpdatePriceFeed(body.binary.data, PYTH_PRICE_SHARD);
  const sigs: string[] = [];
  for (const { tx, signers } of builder.buildLegacyTransactions({})) {
    sigs.push(await sendAndConfirmTransaction(connection, tx, [payer, ...signers], { commitment: "confirmed" }));
  }
  return sigs;
}
