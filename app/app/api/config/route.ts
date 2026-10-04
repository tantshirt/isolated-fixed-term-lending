import { NextResponse } from "next/server";
import { readDevConfig } from "@/lib/server/dev-config";

export const runtime = "nodejs";

/** Public half of the local config: mints and the price account. Never secrets. */
export async function GET() {
  const config = await readDevConfig();
  if (!config) return NextResponse.json({ config: null });
  return NextResponse.json({
    config: {
      usdcMint: config.usdcMint,
      wsolMint: config.wsolMint,
      priceUpdateAccount: config.priceUpdateAccount,
    },
  });
}
