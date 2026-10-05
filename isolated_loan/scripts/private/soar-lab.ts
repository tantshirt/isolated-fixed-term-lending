// Story 13.1 (SOAR) on Devnet, through the app's routes: the learner signs an
// opt-in registration, a wrong answer is refused, the right answer unlocks the
// achievement once, and a repeat claim does not unlock it again.
// Uses a fresh learner wallet. Needs the app running (APP_URL, default http://localhost:3000).
// Run: npx tsx scripts/private/soar-lab.ts
import { PublicKey, Transaction } from "@solana/web3.js";
import { recordGate } from "../../spikes/lib/evidence";
import { base, program, waitFor } from "../../spikes/lib/custody";
import { newParty } from "./lib/parties";
import { scenarioFrom } from "../../../app/lib/lab-scenario";

const APP = process.env.APP_URL ?? "http://localhost:3000";
const SOAR = new PublicKey("SoarNNzwQHMwcfdkdLc6kvbkoMSxcHy89gTHrjhJYkk");

(async () => {
  const checks: Record<string, unknown> = {};
  const fail: string[] = [];
  const expect = (name: string, ok: boolean, detail: unknown) => {
    checks[name] = { ok, detail };
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail);
    if (!ok) fail.push(name);
  };
  const learner = (await newParty("learner", 50_000_000, 0n)).kp;
  const me = learner.publicKey;
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("lab"), me.toBuffer()], program.programId);
  await program.methods.requestScenario(3).accountsPartial({ learner: me }).signers([learner]).rpc();
  const s = await waitFor("VRF callback", () => program.account.labScenario.fetch(pda).catch(() => null), (x: { status: number }) => x.status === 1, 90);
  const outcome = scenarioFrom(Uint8Array.from(s.randomness)).outcome;

  const reg = await (await fetch(`${APP}/api/lab/register?wallet=${me.toBase58()}`)).json();
  let regSig: string | null = null;
  if (reg.transaction) {
    const tx = Transaction.from(Buffer.from(reg.transaction, "base64"));
    const onlySoar = tx.instructions.every((ix) => ix.programId.equals(SOAR) || ix.programId.equals(PublicKey.default));
    expect("registration-touches-only-soar", onlySoar && !!tx.feePayer?.equals(me), tx.instructions.map((i) => i.programId.toBase58().slice(0, 6)));
    tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
    tx.partialSign(learner);
    regSig = await base.sendRawTransaction(tx.serialize());
    await base.confirmTransaction(regSig, "confirmed");
  }
  expect("learner-registered", reg.transaction ? !!regSig : reg.transaction === null, regSig ?? "already registered");

  const claim = (answer: string) => fetch(`${APP}/api/lab/achievement`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: me.toBase58(), answer }) });
  const wrong = (["repaid", "liquidated", "expired"] as const).find((o) => o !== outcome)!;
  const w = await claim(wrong);
  expect("wrong-answer-refused", w.status === 400, await w.json());
  const r = await claim(outcome);
  const rb = await r.json();
  expect("right-answer-unlocks", r.ok && (rb.signature || rb.already), rb);
  const again = await (await claim(outcome)).json();
  expect("repeat-claim-not-reunlocked", again.already === true, again);

  const status = fail.length ? "FAIL" : "PASS";
  recordGate("13.1-soar", { status, date: new Date().toISOString().slice(0, 10), learner: me.toBase58(), registration: regSig, unlock: rb.signature ?? null, failed: fail, checks });
  console.log(`\nSOAR lab: ${status}`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
