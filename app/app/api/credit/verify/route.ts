import { verifyProof } from "@reclaimprotocol/js-sdk";
import { creditPilotEnabled } from "@/lib/credit/flag";
import { creditEnv, verifyIncome, type VerifyProofFn } from "@/lib/credit/verify-income";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A Reclaim proof is a few kilobytes; anything far larger is refused. */
const MAX_BODY_BYTES = 256 * 1024;
const NO_STORE = { "cache-control": "no-store" };

/**
 * Story 26.7. Verifies a Reclaim income proof server-side and, if eligible, returns a signed
 * request for the SAS credential (tier and expiry only). The proof and the income are discarded
 * inside `verifyIncome`: never stored, logged, or sent to Convex or telemetry.
 */
export async function POST(request: Request) {
  if (!creditPilotEnabled()) return new Response("Not found", { status: 404 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return Response.json({ error: "Request too large." }, { status: 413, headers: NO_STORE });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Send JSON." }, { status: 400, headers: NO_STORE });
  }
  const out = await verifyIncome(body, verifyProof as unknown as VerifyProofFn, creditEnv(), Math.floor(Date.now() / 1000));
  return Response.json(out.body, { status: out.status, headers: NO_STORE });
}
