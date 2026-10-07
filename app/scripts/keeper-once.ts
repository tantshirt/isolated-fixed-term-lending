/**
 * One reference-liquidator pass against Devnet, using the keeper key in ~/.config/zenlo/fixtures.
 * The same code runs every minute in Convex when KEEPER_ENABLED=1.
 *   npx tsx --env-file=.env.local scripts/keeper-once.ts --run
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  if (!process.argv.includes("--run")) throw new Error("This can submit Devnet transactions. Pass --run explicitly.");
  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
  const { Connection, Keypair } = await import("@solana/web3.js");
  const { runKeeperOnce, reconcileKeeperTransactions, DEFAULT_KEEPER_LIMITS } = await import("../lib/v2/keeper");
  const { decodePriceUpdateV2 } = await import("../lib/server/price-update-codec");
  const { PYTH_PRICE_UPDATE_ACCOUNT, MAX_PRICE_AGE_SECONDS } = await import("../lib/constants");
  const { refreshPyth } = await import("./pyth-refresh");
  const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/zenlo/fixtures/keeper.json"), "utf8"))));
  const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  // This standalone runner keeps its own durable budget. Use a different operator wallet
  // from the hosted keeper; local files cannot coordinate with a hosted Convex deployment.
  const statePath = path.join(os.homedir(), ".config/zenlo/fixtures/keeper-state.json");
  const lockPath = `${statePath}.lock`;
  const lock = fs.openSync(lockPath, "wx", 0o600);
  type Entry = { offer: string; signature: string; lastValidBlockHeight: number; payoff: string; kind: "risk" | "overdue"; result: string; at: number };
  try {
    const journal: Entry[] = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : [];
    const save = () => {
      fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(journal), { mode: 0o600 });
      fs.renameSync(`${statePath}.tmp`, statePath);
    };
    const recordOutcome = async (signature: string, result: string) => {
      const entry = journal.find((r) => r.signature === signature);
      if (entry?.result === "pending") { entry.result = result; entry.at = Date.now(); save(); }
    };
    await reconcileKeeperTransactions(connection, journal.filter((r) => r.result === "pending"), recordOutcome);
    const spent = () => journal.filter((r) => r.result === "pending" || (r.result.startsWith("settled") && r.at >= Date.now() - 86_400_000)).reduce((sum, r) => sum + BigInt(r.payoff), 0n);
    const result = await runKeeperOnce({
      connection,
      keeper,
      priceAccount: PYTH_PRICE_UPDATE_ACCOUNT,
      readPrice: async () => {
        const info = await connection.getAccountInfo(PYTH_PRICE_UPDATE_ACCOUNT);
        if (!info) return null;
        const d = decodePriceUpdateV2(info.data as Buffer);
        const publishTime = Number(d.publishTime);
        return { price: d.price, conf: d.conf, exponent: d.exponent, publishTime, fresh: Date.now() / 1000 - publishTime <= MAX_PRICE_AGE_SECONDS - 10, ema: d.emaPrice !== undefined ? { price: d.emaPrice, conf: d.emaConf! } : undefined };
      },
      postPrice: async () => void (await refreshPyth(connection, keeper)),
      recordSignature: async (offer, signature, lastValidBlockHeight, payoff, kind) => {
        if (journal.some((r) => r.signature === signature || (r.offer === offer && r.result === "pending"))) return false;
        if (spent() + BigInt(payoff) > DEFAULT_KEEPER_LIMITS.totalCapital) return false;
        journal.push({ offer, signature, lastValidBlockHeight, payoff, kind, result: "pending", at: Date.now() });
        save();
        return true;
      },
      recordOutcome,
      spentInWindow: spent(),
      now: () => Math.floor(Date.now() / 1000),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
