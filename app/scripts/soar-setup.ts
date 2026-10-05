// Admin, once: create the Lendspan Lab game on SOAR (Devnet) with one
// leaderboard and one achievement, under a dedicated authority key that the
// achievement route signs with. Writes public addresses to lib/private/soar-config.json.
// Run: npx tsx scripts/soar-setup.ts
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { SoarProgram } from "@magicblock-labs/soar-sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))));
const keyFile = new URL("../../isolated_loan/.local/soar-authority.json", import.meta.url);
const configFile = new URL("../lib/private/soar-config.json", import.meta.url);

(async () => {
  if (existsSync(configFile)) return console.log("already set up", readFileSync(configFile, "utf8"));
  const authority = existsSync(keyFile) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyFile, "utf8")))) : Keypair.generate();
  writeFileSync(keyFile, JSON.stringify([...authority.secretKey]));
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: authority.publicKey, lamports: 200_000_000 })), [admin]);

  const soar = SoarProgram.get(new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" }));
  const game = Keypair.generate();
  const g = await soar.initializeNewGame(game.publicKey, "Lendspan Lab", "Learn how fixed-term loans end, with verifiable random scenarios.", 4 /* Genre.Puzzle */, 2 /* GameType.Web */, PublicKey.default, [authority.publicKey]);
  await soar.sendAndConfirmTransaction(g.transaction, [game]);
  const lb = await soar.addNewGameLeaderBoard(game.publicKey, authority.publicKey, "Scenarios read correctly", PublicKey.default, 100, false);
  await soar.sendAndConfirmTransaction(lb.transaction);
  const ach = await soar.addNewGameAchievement(game.publicKey, authority.publicKey, "Read the line", "Predicted how a VRF-generated loan scenario ends: repaid, liquidated, or expired.", PublicKey.default);
  await soar.sendAndConfirmTransaction(ach.transaction);

  const config = { game: game.publicKey.toBase58(), leaderboard: lb.newLeaderBoard.toBase58(), achievement: ach.newAchievement.toBase58(), authority: authority.publicKey.toBase58() };
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
  console.log(config);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
