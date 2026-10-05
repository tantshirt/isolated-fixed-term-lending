import { rejectLocalRequest } from "@/lib/server/local-guard";
import { Connection } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { RPC_URL } from "@/lib/constants";

export const runtime = "nodejs";

/** Local demo only: move the Surfpool clock to a unix timestamp. */
export async function POST(request: Request) {
  const denied = rejectLocalRequest(request);
  if (denied) return denied;
  try {
    const { timestamp } = (await request.json()) as { timestamp?: number };
    if (!timestamp || !Number.isFinite(timestamp)) {
      return NextResponse.json({ error: "Missing timestamp" }, { status: 400 });
    }
    const connection = new Connection(RPC_URL, "confirmed");
    const res = await fetch(connection.rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_timeTravel",
        params: [{ absoluteTimestamp: timestamp * 1000 }],
      }),
    });
    const json = (await res.json()) as { error?: { message: string } };
    if (json.error) throw new Error(json.error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Time travel needs Surfpool";
    return NextResponse.json({ error: message }, { status: 501 });
  }
}
