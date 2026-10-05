import { assertLocalControls } from "./local-guard";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Connection, Keypair } from "@solana/web3.js";
import { RPC_URL } from "../constants";
import { writeDevConfig, type DevConfig } from "./dev-config";
import { writeDevSecrets } from "./dev-secrets";
import {
  defaultMockPrice,
  ensurePriceUpdateAccount,
  fundKeypair,
} from "./pyth-mock";

export type SetupResult = {
  config: DevConfig;
  keypairs: {
    lender: number[];
    borrower: number[];
    liquidator: number[];
  };
};

export async function runLocalSetup(): Promise<SetupResult> {
  assertLocalControls();
  const connection = new Connection(RPC_URL, "confirmed");
  const admin = Keypair.generate();
  await fundKeypair(connection, admin, admin.publicKey);

  const lender = Keypair.generate();
  const borrower = Keypair.generate();
  const liquidator = Keypair.generate();
  const priceUpdate = Keypair.generate();
  const priceWriteAuthority = Keypair.generate();

  for (const kp of [lender, borrower, liquidator, priceWriteAuthority]) {
    await fundKeypair(connection, admin, kp.publicKey);
  }

  const usdcMint = await createMint(
    connection,
    admin,
    admin.publicKey,
    null,
    6
  );
  const wsolMint = await createMint(
    connection,
    admin,
    admin.publicKey,
    null,
    9
  );

  const lenderUsdc = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    usdcMint,
    lender.publicKey
  );
  const borrowerWsol = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    wsolMint,
    borrower.publicKey
  );
  // The borrower needs USDC beyond the principal to pay the interest back.
  const borrowerUsdc = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    usdcMint,
    borrower.publicKey
  );
  const liquidatorUsdc = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    usdcMint,
    liquidator.publicKey
  );

  await mintTo(
    connection,
    admin,
    usdcMint,
    lenderUsdc.address,
    admin,
    1_000_000_000_000
  );
  await mintTo(
    connection,
    admin,
    wsolMint,
    borrowerWsol.address,
    admin,
    100_000_000_000
  );
  await mintTo(
    connection,
    admin,
    usdcMint,
    borrowerUsdc.address,
    admin,
    100_000_000_000
  );
  await mintTo(
    connection,
    admin,
    usdcMint,
    liquidatorUsdc.address,
    admin,
    500_000_000_000
  );

  await ensurePriceUpdateAccount(
    connection,
    admin,
    priceUpdate,
    priceWriteAuthority,
    defaultMockPrice()
  );

  const config: DevConfig = {
    usdcMint: usdcMint.toBase58(),
    wsolMint: wsolMint.toBase58(),
    priceUpdateAccount: priceUpdate.publicKey.toBase58(),
    priceWriteAuthority: priceWriteAuthority.publicKey.toBase58(),
    lender: lender.publicKey.toBase58(),
    borrower: borrower.publicKey.toBase58(),
    liquidator: liquidator.publicKey.toBase58(),
    admin: admin.publicKey.toBase58(),
  };

  await writeDevConfig(config);
  await writeDevSecrets({
    priceUpdateSecret: Array.from(priceUpdate.secretKey),
    priceWriteAuthoritySecret: Array.from(priceWriteAuthority.secretKey),
    adminSecret: Array.from(admin.secretKey),
  });

  return {
    config,
    keypairs: {
      lender: Array.from(lender.secretKey),
      borrower: Array.from(borrower.secretKey),
      liquidator: Array.from(liquidator.secretKey),
    },
  };
}
