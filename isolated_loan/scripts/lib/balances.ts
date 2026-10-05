import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

export async function tokenBalance(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const acc = await connection.getTokenAccountBalance(ata).catch(() => null);
  return acc ? BigInt(acc.value.amount) : 0n;
}

export async function printBalances(
  connection: Connection,
  config: {
    usdcMint: string;
    wsolMint: string;
    lender: string;
    borrower: string;
    liquidator: string;
  },
): Promise<void> {
  const usdc = new PublicKey(config.usdcMint);
  const wsol = new PublicKey(config.wsolMint);
  const lender = new PublicKey(config.lender);
  const borrower = new PublicKey(config.borrower);
  const liquidator = new PublicKey(config.liquidator);

  console.log(
    "lender usdc",
    await tokenBalance(connection, usdc, lender),
  );
  console.log(
    "borrower usdc",
    await tokenBalance(connection, usdc, borrower),
  );
  console.log(
    "borrower wsol",
    await tokenBalance(connection, wsol, borrower),
  );
  console.log(
    "liquidator usdc",
    await tokenBalance(connection, usdc, liquidator),
  );
  console.log(
    "liquidator wsol",
    await tokenBalance(connection, wsol, liquidator),
  );
}
