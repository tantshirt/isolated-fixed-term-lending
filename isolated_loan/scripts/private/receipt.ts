// Story 12.2 on the Devnet TEE: publish a settlement receipt for a settled
// private loan through a Magic Action, and check it lands on Solana once.
// Uses the loan settled by scripts/private/settlement.ts (from the evidence file).
// Run: npx tsx scripts/private/receipt.ts
import { PublicKey, Transaction } from "@solana/web3.js";
import { MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { readFileSync } from "node:fs";
import { loanTermsPda } from "../../../app/lib/private/loan-codec";
import { recordGate } from "../../spikes/lib/evidence";
import { authority, base, program, sleep, teeConnection, waitFor } from "../../spikes/lib/custody";

(async () => {
  const checks: Record<string, unknown> = {};
  const fail: string[] = [];
  const expect = (name: string, ok: boolean, detail: unknown) => {
    checks[name] = { ok, detail };
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail);
    if (!ok) fail.push(name);
  };
  const evidence = JSON.parse(readFileSync(new URL("../../../docs/magicblock-evidence.json", import.meta.url), "utf8"));
  const loan = new PublicKey(evidence.gates["12.1"].loan);
  const [receipt] = PublicKey.findProgramAddressSync([Buffer.from("receipt"), loan.toBuffer()], program.programId);
  const er = await teeConnection(authority);

  const publish = async () => {
    const tx = new Transaction().add(
      await program.methods
        .publishReceipt()
        .accountsPartial({
          publisher: authority.publicKey,
          anchor: loan,
          terms: loanTermsPda(loan),
          receipt,
          magicContext: MAGIC_CONTEXT_ID,
          magicProgram: MAGIC_PROGRAM_ID,
        })
        .instruction(),
    );
    tx.feePayer = authority.publicKey;
    tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    tx.sign(authority);
    const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const res = await er.confirmTransaction(sig, "confirmed");
    return { sig, err: res.value.err };
  };

  const first = await publish();
  expect("publish-in-er", first.err === null, first);
  const r = await waitFor("receipt on Solana", () => program.account.settlementReceipt.fetch(receipt).catch(() => null), (x: { status: number }) => x.status !== 0, 120).catch(() => null);
  expect("receipt-written-on-solana", !!r && r.status === 4, r ? { status: r.status, settledAt: r.settledAt.toNumber(), commitment: Buffer.from(r.commitment).toString("hex").slice(0, 16) } : "not written");
  const raw = await base.getAccountInfo(receipt);
  expect("receipt-holds-no-terms", !!raw && raw.data.length === 8 + 32 + 1 + 32 + 8 + 1, { bytes: raw?.data.length });

  await sleep(3000);
  const second = await publish();
  await sleep(20000);
  const after = await program.account.settlementReceipt.fetch(receipt);
  expect("second-receipt-does-not-overwrite", Buffer.from(after.commitment).equals(Buffer.from(r!.commitment)) && after.settledAt.eq(r!.settledAt), {
    secondPublish: second.err ?? "accepted in ER; action rejected on Solana",
  });

  const status = fail.length ? "FAIL" : "PASS";
  recordGate("12.2", { status, date: new Date().toISOString().slice(0, 10), loan: loan.toBase58(), receipt: receipt.toBase58(), signatures: { publish: first.sig }, failed: fail, checks });
  console.log(`\nStory 12.2: ${status}`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
