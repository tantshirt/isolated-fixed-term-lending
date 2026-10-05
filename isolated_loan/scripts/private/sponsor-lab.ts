// Story 13.1 (bounded sponsorship) on Devnet, through the app's route: a wallet
// with zero SOL gets its first lab draw sponsored, the transaction holds only the
// rent transfer and its own request, and a second or a funded wallet is refused.
// Run (app running): npx tsx scripts/private/sponsor-lab.ts
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { recordGate } from "../../spikes/lib/evidence";
import { authority, base, program, waitFor } from "../../spikes/lib/custody";

const APP = process.env.APP_URL ?? "http://localhost:3000";

(async () => {
  const checks: Record<string, unknown> = {};
  const fail: string[] = [];
  const expect = (name: string, ok: boolean, detail: unknown) => {
    checks[name] = { ok, detail };
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail);
    if (!ok) fail.push(name);
  };
  const ask = (wallet: PublicKey) => fetch(`${APP}/api/lab/sponsor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.toBase58() }) });

  const learner = Keypair.generate();
  const me = learner.publicKey;
  const res = await (await ask(me)).json();
  const tx = Transaction.from(Buffer.from(res.transaction, "base64"));
  const [fund, request] = tx.instructions;
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("lab"), me.toBuffer()], program.programId);
  const shape = tx.instructions.length === 2 && fund.programId.equals(SystemProgram.programId) && fund.keys[1].pubkey.equals(me) && request.programId.equals(program.programId) && request.keys[1].pubkey.equals(pda);
  expect("sponsored-tx-is-rent-plus-own-request", shape, { feePayer: tx.feePayer?.toBase58(), lamports: Number(fund.data.readBigUInt64LE(4)) });
  tx.partialSign(learner);
  const sig = await base.sendRawTransaction(tx.serialize());
  await base.confirmTransaction(sig, "confirmed");
  const ready = await waitFor("VRF callback", () => program.account.labScenario.fetch(pda).catch(() => null), (x: { status: number }) => x.status === 1, 90).catch(() => null);
  expect("zero-sol-wallet-drew-a-scenario", !!ready, sig);
  expect("learner-kept-no-sponsored-sol", (await base.getBalance(me)) === 0, await base.getBalance(me));

  const again = await ask(me);
  expect("second-draw-refused", again.status === 400, await again.json());
  const rich = Keypair.generate().publicKey;
  await sendAndConfirmTransaction(base, new Transaction().add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: rich, lamports: 5_000_000 })), [authority]);
  const funded = await ask(rich);
  expect("funded-wallet-refused", funded.status === 400, await funded.json());

  const status = fail.length ? "FAIL" : "PASS";
  recordGate("13.1-sponsorship", { status, date: new Date().toISOString().slice(0, 10), learner: me.toBase58(), transaction: sig, failed: fail, checks });
  console.log(`\nSponsorship: ${status}`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
