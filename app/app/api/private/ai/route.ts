import { PublicKey } from "@solana/web3.js";
import { AiRejected, AiUnavailable, aiModel, answerRequest } from "@/lib/server/ai-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Which model the disclosure preview must name. Nothing private is returned. */
export async function GET() {
  const configured = !!process.env.PRIVATE_AI_WORKER_SECRET && !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
  return Response.json({ configured, model: aiModel(), provider: "Vercel AI Gateway" });
}

/** Body: { room, requestId (hex), excerpt }. The excerpt must hash to the on-chain approval. */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (typeof body?.excerpt !== "string" || body.excerpt.length > 4000) throw new AiRejected("Invalid excerpt.");
    if (typeof body?.requestId !== "string" || !/^[0-9a-f]{64}$/.test(body.requestId)) throw new AiRejected("Invalid request id.");
    const room = new PublicKey(String(body.room));
    const { signature, result } = await answerRequest(room, Buffer.from(body.requestId, "hex"), body.excerpt);
    return Response.json({ signature, result });
  } catch (e) {
    if (e instanceof AiUnavailable) return Response.json({ error: e.message }, { status: 503 });
    if (e instanceof AiRejected) return Response.json({ error: e.message }, { status: 400 });
    console.error("private ai", e instanceof Error ? e.message : e);
    return Response.json({ error: "The copilot could not answer. Your loan terms were not changed; start a new request to try again." }, { status: 502 });
  }
}
