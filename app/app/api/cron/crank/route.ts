import { timingSafeEqual } from "node:crypto";
import { crankerKey, runCranker, teeAs } from "@/lib/server/cranker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function sameSecret(given: string | null, expected: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Vercel Cron, every minute. Vercel sends `Authorization: Bearer $CRON_SECRET`. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !sameSecret(request.headers.get("authorization"), `Bearer ${secret}`)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const kp = crankerKey();
  if (!kp) return Response.json({ error: "Cranker not configured" }, { status: 503 });
  try {
    const run = await runCranker(await teeAs(kp), kp);
    await reportToShadow({ slot: run.slot, triggered: run.results.filter((r) => !r.error).map((r) => r.crank) });
    return Response.json(run);
  } catch (e) {
    console.error("cranker", e instanceof Error ? e.message : e);
    await reportToShadow({ slot: "0", triggered: [], error: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "Cranker run failed; the next run retries." }, { status: 502 });
  }
}

/** Best effort: parity reporting for the Convex shadow scheduler must never fail the live run. */
async function reportToShadow(body: { slot: string; triggered: string[]; error?: string }) {
  const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  const secret = process.env.OPS_REPORT_SECRET;
  if (!site || !secret) return;
  try {
    await fetch(`${site}/ops/crank-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // Parity simply shows a gap for this minute.
  }
}
