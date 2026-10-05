import { rejectLocalRequest } from "@/lib/server/local-guard";
import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { fundWallet } from "@/lib/server/fund";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = rejectLocalRequest(request);
  if (denied) return denied;
  try {
    const { publicKey } = (await request.json()) as { publicKey?: string };
    if (!publicKey)
      return NextResponse.json({ error: "Missing publicKey" }, { status: 400 });
    await fundWallet(new PublicKey(publicKey));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Funding failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
