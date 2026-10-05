import { PublicKey } from "@solana/web3.js";
import { registrationTx } from "@/lib/server/soar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns an unsigned SOAR registration for the learner to review and sign. */
export async function GET(request: Request) {
  try {
    const wallet = new PublicKey(new URL(request.url).searchParams.get("wallet") ?? "");
    return Response.json({ transaction: await registrationTx(wallet) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 160) : "Could not build the registration." }, { status: 400 });
  }
}
