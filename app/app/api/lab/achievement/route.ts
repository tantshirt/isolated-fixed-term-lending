import { PublicKey } from "@solana/web3.js";
import { LabRejected, unlock } from "@/lib/server/soar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Body: { wallet, answer }. Unlocks "Read the line" only for a correct answer to the learner's own VRF scenario. */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!["repaid", "liquidated", "expired"].includes(body?.answer)) throw new LabRejected("Invalid answer.");
    return Response.json(await unlock(new PublicKey(String(body.wallet)), body.answer));
  } catch (e) {
    const status = e instanceof LabRejected ? 400 : 502;
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "Could not record the achievement." }, { status });
  }
}
