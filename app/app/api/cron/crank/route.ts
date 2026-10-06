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
    return Response.json(await runCranker(await teeAs(kp), kp));
  } catch (e) {
    console.error("cranker", e instanceof Error ? e.message : e);
    return Response.json({ error: "Cranker run failed; the next run retries." }, { status: 502 });
  }
}
