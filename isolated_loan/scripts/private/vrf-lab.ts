// Story 13.1 (VRF lab) on Devnet: request a scenario and wait for the VRF
// program's callback to write verifiable randomness. A direct callback fails.
// Run: npx tsx scripts/private/vrf-lab.ts
import { PublicKey } from "@solana/web3.js";
import { recordGate } from "../../spikes/lib/evidence";
import { authority, program, waitFor } from "../../spikes/lib/custody";

const QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");

(async () => {
  const checks: Record<string, unknown> = {};
  const fail: string[] = [];
  const expect = (name: string, ok: boolean, detail: unknown) => {
    checks[name] = { ok, detail };
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail);
    if (!ok) fail.push(name);
  };
  const [scenario] = PublicKey.findProgramAddressSync([Buffer.from("lab"), authority.publicKey.toBuffer()], program.programId);
  const sig = await program.methods.requestScenario(7).accountsPartial({ learner: authority.publicKey, scenario, oracleQueue: QUEUE }).rpc();
  const ready = await waitFor("VRF callback", () => program.account.labScenario.fetch(scenario).catch(() => null), (s: { status: number }) => s.status === 1, 90).catch(() => null);
  expect("vrf-callback-wrote-randomness", !!ready && ready.randomness.some((b: number) => b !== 0), ready ? { rounds: ready.rounds, randomness: Buffer.from(ready.randomness).toString("hex").slice(0, 16) } : "no callback");
  let forged = false;
  try {
    await program.methods.scenarioCallback([...Buffer.alloc(32, 1)]).accountsPartial({ scenario }).rpc();
  } catch {
    forged = true;
  }
  expect("direct-callback-rejected", forged, "only the VRF program identity may call back");
  const status = fail.length ? "FAIL" : "PASS";
  recordGate("13.1-vrf", { status, date: new Date().toISOString().slice(0, 10), scenario: scenario.toBase58(), request: sig, failed: fail, checks });
  console.log(`\nVRF lab: ${status}`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
