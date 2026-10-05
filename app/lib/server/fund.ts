import { assertLocalControls } from "./local-guard";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { RPC_URL } from "../constants";
import { readDevConfig } from "./dev-config";
import { readDevSecrets } from "./dev-secrets";
import { runLocalSetup } from "./setup-dev";

export const FUND_AMOUNTS = {
  sol: 2,
  usdc: 10_000,
  wsol: 50,
} as const;

/** Local test only: SOL for fees, plus test USDC and wSOL, to any wallet. */
export async function fundWallet(target: PublicKey): Promise<void> {
  assertLocalControls();
  const connection = new Connection(RPC_URL, "confirmed");
  let config = await readDevConfig();
  let secrets = await readDevSecrets();
  if (!config || !secrets?.adminSecret) {
    await runLocalSetup();
    config = await readDevConfig();
    secrets = await readDevSecrets();
  }
  if (!config || !secrets?.adminSecret)
    throw new Error("Local setup did not finish");

  const admin = Keypair.fromSecretKey(Uint8Array.from(secrets.adminSecret));
  const sig = await connection.requestAirdrop(
    target,
    FUND_AMOUNTS.sol * LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(sig, "confirmed");

  const usdcMint = new PublicKey(config.usdcMint);
  const wsolMint = new PublicKey(config.wsolMint);
  const usdc = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    usdcMint,
    target
  );
  const wsol = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    wsolMint,
    target
  );
  await mintTo(
    connection,
    admin,
    usdcMint,
    usdc.address,
    admin,
    FUND_AMOUNTS.usdc * 1_000_000
  );
  await mintTo(
    connection,
    admin,
    wsolMint,
    wsol.address,
    admin,
    FUND_AMOUNTS.wsol * 1_000_000_000
  );
}
