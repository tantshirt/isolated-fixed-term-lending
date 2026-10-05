import { rejectLocalRequest } from "@/lib/server/local-guard";
import { NextResponse } from "next/server";
import { runLocalSetup } from "@/lib/server/setup-dev";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = rejectLocalRequest(request);
  if (denied) return denied;
  try {
    const result = await runLocalSetup();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Setup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
