import { IS_LOCAL, DEVNET_USDC_MINT, NATIVE_WSOL_MINT } from "./constants";
import { submitTransaction } from "./transaction-lifecycle";
import { getConnection } from "./program";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { asSigner, type LoanSigner } from "./keypair-wallet";
import { bnU64, getProgram } from "./program";
import { offerPda, usdcVaultPda, wsolVaultPda } from "./pda";

type AnySigner = Keypair | LoanSigner;

export type CreateOfferParams = {
  offerId: bigint;
  principal: bigint;
  interestBps: number;
  durationSeconds: number;
  collateralAmount: bigint;
  maxLtvBps: number;
  liquidationLtvBps: number;
  usdcMint: PublicKey;
  wsolMint: PublicKey;
};

/** Creates `owner`'s ATA for `mint` if missing; `payer` pays rent. */
function ensureAta(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    getAssociatedTokenAddressSync(mint, owner),
    owner,
    mint
  );
}

export async function sendCreateOffer(
  lenderSigner: AnySigner,
  params: CreateOfferParams
): Promise<{ offer: PublicKey; signature: string }> {
  if (
    !IS_LOCAL &&
    (!params.usdcMint.equals(DEVNET_USDC_MINT) ||
      !params.wsolMint.equals(NATIVE_WSOL_MINT))
  )
    throw new Error(
      "Devnet offers require canonical Devnet USDC and native wSOL"
    );
  const signer = asSigner(lenderSigner);
  const lender = signer.publicKey;
  const program = getProgram(signer);
  const offer = offerPda(lender, params.offerId);

  const signature = await program.methods
    .createOffer(
      bnU64(params.offerId),
      bnU64(params.principal),
      params.interestBps,
      bnU64(params.durationSeconds),
      bnU64(params.collateralAmount),
      params.maxLtvBps,
      params.liquidationLtvBps
    )
    .accountsPartial({
      lender,
      offer,
      usdcMint: params.usdcMint,
      wsolMint: params.wsolMint,
      usdcVault: usdcVaultPda(offer),
      lenderUsdc: getAssociatedTokenAddressSync(params.usdcMint, lender),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction()
    .then((tx) => submitTransaction(getConnection(), signer, tx));

  return { offer, signature };
}

export async function sendCancelOffer(
  lenderSigner: AnySigner,
  offer: PublicKey,
  usdcMint: PublicKey
): Promise<string> {
  const signer = asSigner(lenderSigner);
  const lender = signer.publicKey;
  return getProgram(signer)
    .methods.cancelOffer()
    .accountsPartial({
      lender,
      offer,
      usdcVault: usdcVaultPda(offer),
      lenderUsdc: getAssociatedTokenAddressSync(usdcMint, lender),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([ensureAta(lender, lender, usdcMint)])
    .transaction()
    .then((tx) => submitTransaction(getConnection(), signer, tx));
}

export async function sendAcceptOffer(
  borrowerSigner: AnySigner,
  offer: PublicKey,
  lender: PublicKey,
  usdcMint: PublicKey,
  wsolMint: PublicKey,
  priceUpdate: PublicKey
): Promise<string> {
  const signer = asSigner(borrowerSigner);
  const borrower = signer.publicKey;
  return getProgram(signer)
    .methods.acceptOffer()
    .accountsPartial({
      borrower,
      offer,
      lender,
      priceUpdate,
      usdcVault: usdcVaultPda(offer),
      wsolMint,
      wsolVault: wsolVaultPda(offer),
      borrowerUsdc: getAssociatedTokenAddressSync(usdcMint, borrower),
      borrowerWsol: getAssociatedTokenAddressSync(wsolMint, borrower),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([
      ensureAta(borrower, borrower, usdcMint),
      ensureAta(borrower, borrower, wsolMint),
    ])
    .transaction()
    .then((tx) => submitTransaction(getConnection(), signer, tx));
}

export async function sendRepayLoan(
  borrowerSigner: AnySigner,
  offer: PublicKey,
  lender: PublicKey,
  usdcMint: PublicKey,
  wsolMint: PublicKey
): Promise<string> {
  const signer = asSigner(borrowerSigner);
  const borrower = signer.publicKey;
  return (
    getProgram(signer)
      .methods.repayLoan()
      .accountsPartial({
        borrower,
        offer,
        wsolVault: wsolVaultPda(offer),
        borrowerUsdc: getAssociatedTokenAddressSync(usdcMint, borrower),
        lender,
        lenderUsdc: getAssociatedTokenAddressSync(usdcMint, lender),
        borrowerWsol: getAssociatedTokenAddressSync(wsolMint, borrower),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      // A lender who closed their USDC account cannot block repayment.
      .preInstructions([
        ensureAta(borrower, lender, usdcMint),
        ensureAta(borrower, borrower, wsolMint),
      ])
      .transaction()
      .then((tx) => submitTransaction(getConnection(), signer, tx))
  );
}

export async function sendClaimExpired(
  callerSigner: AnySigner,
  offer: PublicKey,
  lender: PublicKey,
  borrower: PublicKey,
  wsolMint: PublicKey
): Promise<string> {
  const signer = asSigner(callerSigner);
  const caller = signer.publicKey;
  return getProgram(signer)
    .methods.claimExpiredLoan()
    .accountsPartial({
      caller,
      offer,
      wsolVault: wsolVaultPda(offer),
      lender,
      lenderWsol: getAssociatedTokenAddressSync(wsolMint, lender),
      borrower,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([ensureAta(caller, lender, wsolMint)])
    .transaction()
    .then((tx) => submitTransaction(getConnection(), signer, tx));
}

export async function sendLiquidateLoan(
  callerSigner: AnySigner,
  offer: PublicKey,
  lender: PublicKey,
  borrower: PublicKey,
  usdcMint: PublicKey,
  wsolMint: PublicKey,
  priceUpdate: PublicKey
): Promise<string> {
  const signer = asSigner(callerSigner);
  const caller = signer.publicKey;
  return getProgram(signer)
    .methods.liquidateLoan()
    .accountsPartial({
      caller,
      offer,
      priceUpdate,
      wsolVault: wsolVaultPda(offer),
      callerUsdc: getAssociatedTokenAddressSync(usdcMint, caller),
      lender,
      lenderUsdc: getAssociatedTokenAddressSync(usdcMint, lender),
      borrower,
      borrowerWsol: getAssociatedTokenAddressSync(wsolMint, borrower),
      callerWsol: getAssociatedTokenAddressSync(wsolMint, caller),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([
      ensureAta(caller, caller, usdcMint),
      ensureAta(caller, caller, wsolMint),
      ensureAta(caller, lender, usdcMint),
      ensureAta(caller, borrower, wsolMint),
    ])
    .transaction()
    .then((tx) => submitTransaction(getConnection(), signer, tx));
}

/** Lender reclaims the offer account's rent once the loan has ended. */
export async function sendCloseOffer(
  lenderSigner: AnySigner,
  offer: PublicKey
): Promise<string> {
  const signer = asSigner(lenderSigner);
  return getProgram(signer)
    .methods.closeOffer()
    .accountsPartial({ lender: signer.publicKey, offer })
    .transaction()
    .then((tx) => submitTransaction(getConnection(), signer, tx));
}

/** Explicit user action; amount is additional wSOL in lamports, never the full wallet balance. */
export async function sendWrapSol(
  wallet: AnySigner,
  amount: bigint
): Promise<string> {
  const { NATIVE_MINT, ACCOUNT_SIZE, createSyncNativeInstruction } =
    await import("@solana/spl-token");
  const { Transaction } = await import("@solana/web3.js");
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Enter a positive, safely representable SOL amount");
  const signer = asSigner(wallet);
  const connection = getConnection();
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, signer.publicKey);
  const [balance, rent, existing] = await Promise.all([
    connection.getBalance(signer.publicKey),
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
    connection.getAccountInfo(ata),
  ]);
  const reserve = 10_000_000n; // Retain 0.01 SOL for subsequent loan transaction fees.
  if (BigInt(balance) < amount + BigInt(existing ? 0 : rent) + reserve)
    throw new Error(
      "Insufficient SOL after retaining token-account rent and a 0.01 SOL fee reserve"
    );
  return submitTransaction(
    connection,
    signer,
    new Transaction().add(
      ensureAta(signer.publicKey, signer.publicKey, NATIVE_MINT),
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: ata,
        lamports: amount,
      }),
      createSyncNativeInstruction(ata)
    )
  );
}
