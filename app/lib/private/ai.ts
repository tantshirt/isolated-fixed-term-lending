// AI copilot from the browser (story 11.2). The user sees the exact excerpt and
// model, signs a request bound to its hash (and the loan revision), then sends
// that excerpt to the app's worker route. The answer comes back through the TEE.
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import idl from "@/idl/private_loan.json";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { debt } from "@/lib/loan-math";
import { AI_TASK, aiConfigPda, aiRequestPda, decodeAiRequest, disclosureHash, type AiRequestRecord, type AiTask } from "./ai-codec";
import { MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, permissionPda } from "./espl";
import { loanTermsPda, type LoanTerms } from "./loan-codec";
import { advance, newReceipt, saveReceipt } from "./receipts";
import { roomStatePda } from "./room-codec";
import { validateTransaction } from "./tx-validator";

const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");

export type AiInfo = { configured: boolean; model: string; provider: string };
export async function aiInfo(): Promise<AiInfo> {
  return (await fetch("/api/private/ai", { cache: "no-store" })).json();
}

const usdc = (a: bigint) => (Number(a) / 1e6).toString();

/** The exact text the model will receive. Built from computed facts, plus the user's own words for drafts. */
export function buildExcerpt(task: AiTask, loans: LoanTerms[], userText = ""): string {
  const lines = loans.map((t, i) =>
    [
      loans.length > 1 ? `Offer ${i + 1}:` : "Loan:",
      `borrower receives ${usdc(t.principal)} USDC, repays ${usdc(debt(t.principal, t.interestBps))} USDC (${t.interestBps / 100}% for the whole term);`,
      `collateral ${Number(t.collateralAmount) / 1e9} wSOL; max LTV ${t.maxLtvBps / 100}%, liquidation line ${t.liquidationLtvBps / 100}%;`,
      `term ${(t.durationSeconds / 3600).toFixed(2)} hours; status ${t.status}; revision ${t.revision}.`,
    ].join(" "),
  );
  const caps = "Caps: interest at most 20%, max LTV 70%, liquidation line at most 85%, term 1 minute to 90 days.";
  return [...lines, task === "draft" || task === "explainError" ? `Request: ${userText.trim()}` : "", caps].filter(Boolean).join("\n");
}

export async function askCopilot(
  base: Connection,
  er: Connection,
  signer: LoanSigner,
  room: PublicKey,
  task: AiTask,
  excerpt: string,
  model: string,
  loan: { anchor: PublicKey; revision: number } | null,
): Promise<AiRequestRecord> {
  const program = new Program(idl as Idl, new AnchorProvider(base, signer, { commitment: "confirmed" }));
  const requestId = crypto.getRandomValues(new Uint8Array(32));
  const request = aiRequestPda(room, requestId);
  const tx = new Transaction().add(
    await program.methods
      .createAiRequest([...requestId], AI_TASK[task], [...(await disclosureHash(model, excerpt))], loan?.revision ?? 0, new BN(300))
      .accountsPartial({
        requester: signer.publicKey,
        room,
        roomState: roomStatePda(room),
        config: aiConfigPda(),
        loan: (loan?.anchor ?? null) as PublicKey,
        terms: (loan ? loanTermsPda(loan.anchor) : null) as PublicKey,
        request,
        requestPermission: permissionPda(request),
        vault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        permissionProgram: PERMISSION_PROGRAM_ID,
      })
      .instruction(),
  );
  tx.feePayer = signer.publicKey;
  validateTransaction(tx, { feePayer: signer.publicKey });
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  const signed = await signer.signTransaction(tx);
  const receipt = newReceipt("Approve an AI disclosure", "er", loan?.revision);
  const sig = await er.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  const res = await er.confirmTransaction(sig, "confirmed");
  saveReceipt(signer.publicKey.toBase58(), advance(receipt, { erSignature: sig, stage: res.value.err ? "failed" : "executed" }));
  if (res.value.err) throw new Error("The private rollup rejected the request. If the terms just changed, reload and try again.");

  const hex = Array.from(requestId, (b) => b.toString(16).padStart(2, "0")).join("");
  const r = await fetch("/api/private/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room: room.toBase58(), requestId: hex, excerpt }),
  });
  if (!r.ok) throw new Error((await r.json()).error ?? "The copilot could not answer.");
  for (let i = 0; i < 20; i++) {
    const info = await er.getAccountInfo(request);
    if (info) {
      const rec = decodeAiRequest(info.data);
      if (rec.answered) return rec;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("The answer has not arrived yet. It is saved with the request; check again shortly.");
}
