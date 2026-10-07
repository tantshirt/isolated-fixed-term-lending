import { ReclaimProofRequest } from "@reclaimprotocol/js-sdk";
import { PublicKey } from "@solana/web3.js";
import { creditPilotEnabled } from "@/lib/credit/flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Story 26.7. Starts a Reclaim income-proof session for one wallet. The app secret stays here; the
 * browser gets only the SDK's serialized request. The wallet is set as the proof context, so the
 * verify route can refuse a proof made for anyone else.
 */
export async function POST(request: Request) {
  if (!creditPilotEnabled()) return new Response("Not found", { status: 404 });
  const appId = process.env.NEXT_PUBLIC_RECLAIM_APP_ID;
  const secret = process.env.RECLAIM_APP_SECRET;
  const provider = process.env.RECLAIM_PROVIDER_ID;
  if (!appId || !secret || !provider) return Response.json({ error: "Income verification is not configured on this deployment." }, { status: 503, headers: NO_STORE });
  let wallet: string;
  try {
    const body = (await request.json()) as { wallet?: unknown };
    wallet = new PublicKey(typeof body.wallet === "string" ? body.wallet : "").toBase58();
  } catch {
    return Response.json({ error: "That wallet address is not valid." }, { status: 400, headers: NO_STORE });
  }
  try {
    const req = await ReclaimProofRequest.init(appId, secret, provider);
    req.setContext(wallet, "zenlo-credit-v1");
    return Response.json({ request: req.toJsonString() }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "Reclaim could not start a session. Try again later." }, { status: 503, headers: NO_STORE });
  }
}
