// AI copilot record layout and disclosure binding (programs/private_loan/src/ai.rs).
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { PRIVATE_PROGRAM_ID } from "./room-codec";

export const AI_TASK = { explainLoan: 1, compare: 2, draft: 3, counter: 4, explainError: 5 } as const;
export type AiTask = keyof typeof AI_TASK;
export const AI_TASK_LABEL: Record<AiTask, string> = {
  explainLoan: "Explain this loan",
  compare: "Compare my offers",
  draft: "Draft terms from a sentence",
  counter: "Suggest a counteroffer",
  explainError: "Explain what went wrong",
};
export const RESULT_MAX = 700;

const enc = new TextEncoder();
export const aiConfigPda = () => PublicKey.findProgramAddressSync([enc.encode("ai-config")], PRIVATE_PROGRAM_ID)[0];
export const aiRequestPda = (room: PublicKey, requestId: Uint8Array) =>
  PublicKey.findProgramAddressSync([enc.encode("ai"), room.toBytes(), requestId], PRIVATE_PROGRAM_ID)[0];

/**
 * The approval binds both the model and the exact text. The worker recomputes
 * this with its configured model, so a different model or a changed excerpt
 * does not match what the user approved.
 */
export async function disclosureHash(model: string, excerpt: string): Promise<Uint8Array> {
  const bytes = enc.encode(`${model}\n${excerpt}`);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export const aiResultSchema = z.object({
  kind: z.enum(["explanation", "proposal"]),
  text: z.string().max(420).describe("Plain-language answer for a beginner. No promises about returns."),
  proposal: z
    .object({
      principalUsdc: z.number().positive(),
      interestPercent: z.number().min(0).max(20),
      durationDays: z.number().positive().max(90).describe("Fractions allowed; one hour is about 0.042."),
      collateralWsol: z.number().positive(),
    })
    .optional()
    .describe("Only for draft or counteroffer tasks. Must respect the caps in the excerpt."),
});
export type AiResult = z.infer<typeof aiResultSchema>;

export type AiRequestRecord = {
  requester: PublicKey;
  room: PublicKey;
  loan: PublicKey | null;
  task: number;
  payloadHash: Uint8Array;
  revision: number;
  createdAt: number;
  deadline: number;
  answered: boolean;
  answeredAt: number;
  stale: boolean;
  result: AiResult | null;
  raw: string;
};

export function decodeAiRequest(data: Uint8Array): AiRequestRecord {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (o: number) => new PublicKey(data.slice(o, o + 32));
  const loan = key(65);
  const len = v.getUint16(160, true);
  const raw = new TextDecoder().decode(data.slice(162, 162 + len));
  let result: AiResult | null = null;
  try {
    result = aiResultSchema.parse(JSON.parse(raw));
  } catch {
    result = null;
  }
  return {
    requester: key(1),
    room: key(33),
    loan: loan.equals(PublicKey.default) ? null : loan,
    task: data[97],
    payloadHash: data.slice(98, 130),
    revision: v.getUint32(130, true),
    createdAt: Number(v.getBigInt64(134, true)),
    deadline: Number(v.getBigInt64(142, true)),
    answered: data[150] === 1,
    answeredAt: Number(v.getBigInt64(151, true)),
    stale: data[159] === 1,
    result,
    raw,
  };
}

/** Compact JSON that fits the on-chain result buffer. */
export function encodeResult(r: AiResult): Uint8Array {
  let text = r.text;
  for (;;) {
    const bytes = enc.encode(JSON.stringify({ ...r, text }));
    if (bytes.length <= RESULT_MAX) return bytes;
    text = text.slice(0, Math.max(0, text.length - 20)) + "…";
  }
}
