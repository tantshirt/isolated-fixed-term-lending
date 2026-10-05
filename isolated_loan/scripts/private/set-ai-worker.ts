// Admin: register the AI worker key and turn the copilot on (or off with --off).
// Run: npx tsx scripts/private/set-ai-worker.ts [--off]
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { authority, program } from "../../spikes/lib/custody";

(async () => {
  const worker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../../.local/ai-worker.json", import.meta.url), "utf8"))));
  const enabled = !process.argv.includes("--off");
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("ai-config")], program.programId);
  const sig = await program.methods.setAiWorker(worker.publicKey, enabled).accountsPartial({ admin: authority.publicKey, config }).rpc();
  console.log(`AI worker ${worker.publicKey.toBase58()} ${enabled ? "enabled" : "disabled"}: ${sig}`);
})();
