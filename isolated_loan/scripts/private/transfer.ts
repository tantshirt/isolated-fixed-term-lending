// Story 13.1 (private transfers) on the Devnet TEE: a checked SPL transfer
// between two private balances. Exact amounts; outsiders read masked values.
// Run: npx tsx scripts/private/transfer.ts
import { Keypair, Transaction } from "@solana/web3.js";
import { createTransferCheckedInstruction } from "@solana/spl-token";
import { ata } from "../../../app/lib/private/espl";
import { validateTransaction } from "../../../app/lib/private/tx-validator";
import { recordGate } from "../../spikes/lib/evidence";
import { teeConnection } from "../../spikes/lib/custody";
import { USDC, cashOut, makePrivate, newParty, privateBalance } from "./lib/parties";

(async () => {
  const checks: Record<string, unknown> = {};
  const fail: string[] = [];
  const expect = (name: string, ok: boolean, detail: unknown) => {
    checks[name] = { ok, detail };
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail);
    if (!ok) fail.push(name);
  };
  const sender = await newParty("sender", 40_000_000, 50_000n);
  const recipient = await newParty("recipient", 40_000_000, 0n);
  const outsider = await teeConnection(Keypair.generate());
  await makePrivate(sender, USDC, 50_000n);
  await makePrivate(recipient, USDC, 0n);

  const amount = 12_345n;
  const tx = new Transaction().add(createTransferCheckedInstruction(ata(sender.kp.publicKey, USDC), USDC, ata(recipient.kp.publicKey, USDC), sender.kp.publicKey, amount, 6));
  tx.feePayer = sender.kp.publicKey;
  validateTransaction(tx, { feePayer: sender.kp.publicKey, transfers: [{ kind: "send", owner: sender.kp.publicKey, mint: USDC, amount, destination: ata(recipient.kp.publicKey, USDC) }] });
  tx.recentBlockhash = (await sender.er.getLatestBlockhash()).blockhash;
  tx.sign(sender.kp);
  const sig = await sender.er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await sender.er.confirmTransaction(sig, "confirmed");
  expect("transfer-executed-in-er", res.value.err === null, sig);
  const [s, r] = [await privateBalance(sender, USDC), await privateBalance(recipient, USDC)];
  expect("exact-private-balances", s === 50_000n - amount && r === amount, { sender: s?.toString(), recipient: r?.toString() });
  const seen = await outsider.getTokenAccountBalance(ata(recipient.kp.publicKey, USDC)).then((b) => b.value.amount).catch(() => null);
  expect("outsider-sees-masked-balance", seen !== amount.toString(), { outsider: seen });

  await cashOut(sender, [USDC]);
  await cashOut(recipient, [USDC]);
  const status = fail.length ? "FAIL" : "PASS";
  recordGate("13.1-transfer", { status, date: new Date().toISOString().slice(0, 10), signature: sig, failed: fail, checks });
  console.log(`\nPrivate transfer: ${status}`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
