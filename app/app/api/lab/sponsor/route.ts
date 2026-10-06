import { PublicKey } from "@solana/web3.js";
import { refuseBots } from "@/lib/server/bot-guard";
import { sponsoredDraw } from "@/lib/server/lab-sponsor";
import { LabRejected } from "@/lib/server/soar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ configured: !!process.env.PRIVATE_LAB_SPONSOR_SECRET });
}

/** Body: { wallet }. Returns a sponsor-signed first lab draw for the learner to review and sign. */
export async function POST(request: Request) {
  const refused = await refuseBots();
  if (refused) return refused;
  try {
    const body = await request.json();
    return Response.json({ transaction: await sponsoredDraw(new PublicKey(String(body?.wallet))) });
  } catch (e) {
    const status = e instanceof LabRejected ? 400 : 502;
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "Could not sponsor this draw." }, { status });
  }
}
