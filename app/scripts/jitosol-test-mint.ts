// Devnet only: the "jitoSOL (test)" collateral mint (Story 26.2).
//
// ZenLo cannot use real jitoSOL on Devnet, so it lends against a ZenLo-made 9-decimal test mint
// priced by the real JITOSOL/USD Pyth feed. This script creates that mint once and mints test
// tokens to a wallet. It never touches isolated_loan_v2: the asset only works after governance
// writes its CollateralConfig through a Squads proposal (docs/devnet.md § jitoSOL (test)).
//
// Run from app/:
//   npx tsx scripts/jitosol-test-mint.ts create                       create the mint (once)
//   npx tsx scripts/jitosol-test-mint.ts mint --to <pubkey> --amount 5 mint 5 test tokens
//   npx tsx scripts/jitosol-test-mint.ts info                         print the mint and the governance call
//
// The payer and mint authority is the Solana CLI default keypair. The mint's address is saved in
// isolated_loan/.local/jitosol-test-mint.json (gitignored).
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { DEVNET_GENESIS_HASH } from "../lib/constants";

const JITOSOL_USD_FEED_ID_HEX = "67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb";
const PROGRAM_V2_ID = new PublicKey(process.env.NEXT_PUBLIC_LOAN_V2_PROGRAM_ID || "8hxagcQkw1Km6PWZgpA92qUnqvnFufC7tx2jvxf9Ko8m");
const DECIMALS = 9;
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))));
const stateDir = new URL("../../isolated_loan/.local/", import.meta.url);
const stateFile = new URL("jitosol-test-mint.json", stateDir);

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const saved = (): PublicKey => {
  if (!existsSync(stateFile)) throw new Error("No test mint yet. Run `create` first.");
  return new PublicKey(JSON.parse(readFileSync(stateFile, "utf8")).mint);
};

function info(mint: PublicKey) {
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("collateral"), mint.toBuffer()], PROGRAM_V2_ID);
  console.log({
    label: "jitoSOL (test)",
    mint: mint.toBase58(),
    decimals: DECIMALS,
    collateralConfig: config.toBase58(),
    env: { NEXT_PUBLIC_JITOSOL_ENABLED: "1", NEXT_PUBLIC_JITOSOL_MINT: mint.toBase58() },
    // The governance call a Squads proposal must execute before any jitoSOL loan works.
    setCollateralConfig: { feedId: JITOSOL_USD_FEED_ID_HEX, maxLtvBps: 6_000, liquidationLtvBps: 7_000, enabled: true },
  });
}

(async () => {
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS_HASH) throw new Error("RPC is not Solana Devnet; refusing to run.");
  const command = process.argv[2];
  if (command === "create") {
    if (existsSync(stateFile)) return info(saved());
    const mint = await createMint(conn, payer, payer.publicKey, null, DECIMALS);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ mint: mint.toBase58(), decimals: DECIMALS, authority: payer.publicKey.toBase58() }, null, 2) + "\n");
    return info(mint);
  }
  if (command === "mint") {
    const to = new PublicKey(arg("to") ?? payer.publicKey.toBase58());
    const amount = Number(arg("amount") ?? "5");
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000) throw new Error("--amount is 0 to 1,000 test tokens.");
    const mint = saved();
    const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, to, true);
    const signature = await mintTo(conn, payer, mint, ata.address, payer, BigInt(Math.round(amount * 10 ** DECIMALS)));
    return console.log({ to: to.toBase58(), tokenAccount: ata.address.toBase58(), amount, signature });
  }
  if (command === "info") return info(saved());
  console.log("Usage: npx tsx scripts/jitosol-test-mint.ts create | mint --to <pubkey> --amount <n> | info");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
