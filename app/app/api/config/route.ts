import { NextResponse } from "next/server";
import { readDevConfig } from "@/lib/server/dev-config";
import {
  IS_LOCAL,
  NETWORK,
  DEVNET_GENESIS_HASH,
  PROGRAM_ID,
  RPC_URL,
  WS_URL,
} from "@/lib/constants";
import { getConnection } from "@/lib/program";
import { PublicKey } from "@solana/web3.js";
import { decodePriceUpdateV2 } from "@/lib/server/price-update-codec";
import { validatePriceAccount } from "@/lib/server/validate-price";
import { chainUnixTime } from "@/lib/server/pyth-mock";
import { localControlsEnabled } from "@/lib/server/local-guard";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  let config: Awaited<ReturnType<typeof readDevConfig>> = null;
  const errors: string[] = [];
  try {
    config = await readDevConfig();
  } catch (error) {
    return NextResponse.json(
      {
        config: null,
        network: NETWORK,
        programId: PROGRAM_ID.toBase58(),
        rpcUrl: RPC_URL,
        wsUrl: WS_URL ?? null,
        localControls: false,
        readiness: {
          ready: false,
          errors: [
            error instanceof Error
              ? error.message
              : "Invalid network configuration",
          ],
        },
      },
      { status: 503 }
    );
  }
  if (!IS_LOCAL && !process.env.NEXT_PUBLIC_LOAN_PROGRAM_ID)
    errors.push(
      "Set NEXT_PUBLIC_LOAN_PROGRAM_ID to the deployed Devnet program"
    );
  if (!config?.priceUpdateAccount)
    errors.push(
      "Configure PYTH_PRICE_UPDATE_ACCOUNT with a receiver-owned SOL/USD account"
    );
  try {
    const connection = getConnection();
    if (
      !IS_LOCAL &&
      (await connection.getGenesisHash()) !== DEVNET_GENESIS_HASH
    )
      errors.push("Configured RPC is not Solana Devnet");
    const program = await connection.getAccountInfo(PROGRAM_ID);
    if (!program?.executable)
      errors.push("Loan program is not deployed on the configured network");
    if (config?.priceUpdateAccount) {
      const account = await connection.getAccountInfo(
        new PublicKey(config.priceUpdateAccount)
      );
      if (!account) errors.push("Pyth price account is missing");
      else
        validatePriceAccount(
          account.owner,
          decodePriceUpdateV2(account.data),
          await chainUnixTime(connection)
        );
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "Readiness RPC check failed");
  }
  return NextResponse.json({
    config: config
      ? {
          usdcMint: config.usdcMint,
          wsolMint: config.wsolMint,
          priceUpdateAccount: config.priceUpdateAccount,
        }
      : null,
    network: NETWORK,
    programId: PROGRAM_ID.toBase58(),
    rpcUrl: RPC_URL,
    wsUrl: WS_URL ?? null,
    localControls: localControlsEnabled(),
    readiness: { ready: errors.length === 0, errors },
  });
}
