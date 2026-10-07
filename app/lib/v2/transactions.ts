import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type Keypair } from "@solana/web3.js";
import { DEVNET_USDC_MINT, IS_LOCAL, NATIVE_WSOL_MINT, PYTH_PRICE_UPDATE_ACCOUNT } from "../constants";
import { asSigner, type LoanSigner } from "../keypair-wallet";
import { bnU64, getConnection } from "../program";
import { submitTransaction } from "../transaction-lifecycle";
import type { EarlyRepayment, TermsV2 } from "../loan-math-v2";
import { getProgramV2, offerV2Pda, requestV2Pda, requestVaultV2Pda, usdcVaultV2Pda, wsolVaultV2Pda } from "./program";
import type { OfferV2, RequestV2 } from "./offers";

type AnySigner = Keypair | LoanSigner;

/** Everything a V2 offer or request fixes at creation. */
export type TermsInput = Omit<TermsV2, "startTs"> & { collateralAmount: bigint; maxLtvBps: number; liquidationLtvBps: number };

function args(t: TermsInput) {
  return {
    principal: bnU64(t.principal),
    interestBps: t.interestBps,
    duration: bnU64(t.duration),
    earlyRepayment: t.earlyRepayment as EarlyRepayment as number,
    minInterestBps: t.minInterestBps,
    graceSeconds: bnU64(t.graceSeconds),
    lateFeeBps: t.lateFeeBps,
    annualCeilingBps: t.annualCeilingBps,
    collateralAmount: bnU64(t.collateralAmount),
    maxLtvBps: t.maxLtvBps,
    liquidationLtvBps: t.liquidationLtvBps,
  };
}

const ata = (mint: PublicKey | string, owner: PublicKey | string) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true);
const ensureAta = (payer: PublicKey, owner: PublicKey | string, mint: PublicKey | string) =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ata(mint, owner), new PublicKey(owner), new PublicKey(mint));

function mints(usdc = DEVNET_USDC_MINT, wsol = NATIVE_WSOL_MINT) {
  if (!IS_LOCAL && (!usdc.equals(DEVNET_USDC_MINT) || !wsol.equals(NATIVE_WSOL_MINT))) throw new Error("Devnet loans use canonical Devnet USDC and native wSOL.");
  return { usdc, wsol };
}

export async function sendCreateOfferV2(
  signerLike: AnySigner,
  offerId: bigint,
  terms: TermsInput,
  opts: { restrictedBorrower?: PublicKey; usdcMint?: PublicKey; wsolMint?: PublicKey; connection?: Connection } = {},
): Promise<{ offer: PublicKey; signature: string }> {
  const signer = asSigner(signerLike);
  const lender = signer.publicKey;
  const { usdc, wsol } = mints(opts.usdcMint, opts.wsolMint);
  const connection = opts.connection ?? getConnection();
  const offer = offerV2Pda(lender, offerId);
  const tx = await getProgramV2(signer, connection)
    .methods.createOffer(bnU64(offerId), args(terms), opts.restrictedBorrower ?? PublicKey.default)
    .accountsPartial({
      lender, offer, usdcMint: usdc, wsolMint: wsol, usdcVault: usdcVaultV2Pda(offer), lenderUsdc: ata(usdc, lender),
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .transaction();
  return { offer, signature: await submitTransaction(connection, signer, tx) };
}

export async function sendCancelOfferV2(signerLike: AnySigner, o: OfferV2, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const lender = signer.publicKey;
  const offer = new PublicKey(o.publicKey);
  const tx = await getProgramV2(signer, connection)
    .methods.cancelOffer()
    .accountsPartial({ lender, offer, usdcVault: usdcVaultV2Pda(offer), lenderUsdc: ata(o.usdcMint, lender), tokenProgram: TOKEN_PROGRAM_ID })
    .preInstructions([ensureAta(lender, lender, o.usdcMint)])
    .transaction();
  return submitTransaction(connection, signer, tx);
}

export async function sendAcceptOfferV2(signerLike: AnySigner, o: OfferV2, priceUpdate = PYTH_PRICE_UPDATE_ACCOUNT, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const borrower = signer.publicKey;
  const offer = new PublicKey(o.publicKey);
  const tx = await getProgramV2(signer, connection)
    .methods.acceptOffer()
    .accountsPartial({
      borrower, offer, lender: new PublicKey(o.originLender), priceUpdate, usdcVault: usdcVaultV2Pda(offer), wsolMint: new PublicKey(o.wsolMint),
      wsolVault: wsolVaultV2Pda(offer), borrowerUsdc: ata(o.usdcMint, borrower), borrowerWsol: ata(o.wsolMint, borrower),
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .preInstructions([ensureAta(borrower, borrower, o.usdcMint), ensureAta(borrower, borrower, o.wsolMint)])
    .transaction();
  return submitTransaction(connection, signer, tx);
}

/** `amount` is the most the borrower signs for; at or above the payoff it closes the loan. */
export async function sendRepayV2(signerLike: AnySigner, o: OfferV2, amount: bigint, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const borrower = signer.publicKey;
  const offer = new PublicKey(o.publicKey);
  const lender = new PublicKey(o.currentLender);
  const tx = await getProgramV2(signer, connection)
    .methods.repay(bnU64(amount))
    .accountsPartial({
      borrower, offer, wsolVault: wsolVaultV2Pda(offer), borrowerUsdc: ata(o.usdcMint, borrower), lender, lenderUsdc: ata(o.usdcMint, lender),
      borrowerWsol: ata(o.wsolMint, borrower), tokenProgram: TOKEN_PROGRAM_ID,
    })
    // A lender who closed their USDC account cannot block repayment.
    .preInstructions([ensureAta(borrower, lender, o.usdcMint), ensureAta(borrower, borrower, o.wsolMint)])
    .transaction();
  return submitTransaction(connection, signer, tx);
}

export async function sendAddCollateralV2(signerLike: AnySigner, o: OfferV2, lamports: bigint, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const borrower = signer.publicKey;
  const offer = new PublicKey(o.publicKey);
  const tx = await getProgramV2(signer, connection)
    .methods.addCollateral(bnU64(lamports))
    .accountsPartial({ borrower, offer, wsolVault: wsolVaultV2Pda(offer), borrowerWsol: ata(o.wsolMint, borrower), tokenProgram: TOKEN_PROGRAM_ID })
    .transaction();
  return submitTransaction(connection, signer, tx);
}

/** Risk liquidation (`overdue: false`) or overdue liquidation after grace (`overdue: true`). */
export async function sendLiquidateV2(signerLike: AnySigner, o: OfferV2, overdue: boolean, priceUpdate = PYTH_PRICE_UPDATE_ACCOUNT, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const caller = signer.publicKey;
  const offer = new PublicKey(o.publicKey);
  const program = getProgramV2(signer, connection);
  const builder = overdue ? program.methods.liquidateOverdue() : program.methods.liquidate();
  const tx = await builder
    .accountsPartial({
      caller, offer, priceUpdate, wsolVault: wsolVaultV2Pda(offer), callerUsdc: ata(o.usdcMint, caller), callerWsol: ata(o.wsolMint, caller),
      lender: new PublicKey(o.currentLender), lenderUsdc: ata(o.usdcMint, o.currentLender), borrower: new PublicKey(o.borrower!),
      borrowerWsol: ata(o.wsolMint, o.borrower!), tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([ensureAta(caller, caller, o.wsolMint), ensureAta(caller, o.currentLender, o.usdcMint), ensureAta(caller, o.borrower!, o.wsolMint)])
    .transaction();
  return submitTransaction(connection, signer, tx);
}

/** Priced recovery (`terminal: false`) or the terminal whole-collateral claim (`terminal: true`). */
export async function sendLenderClaimV2(signerLike: AnySigner, o: OfferV2, terminal: boolean, priceUpdate = PYTH_PRICE_UPDATE_ACCOUNT, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const lender = signer.publicKey;
  const offer = new PublicKey(o.publicKey);
  const program = getProgramV2(signer, connection);
  const builder = terminal ? program.methods.claimTerminal() : program.methods.claimPricedRecovery();
  const tx = await builder
    .accountsPartial({
      lender, offer, priceUpdate, wsolVault: wsolVaultV2Pda(offer), lenderWsol: ata(o.wsolMint, lender), borrower: new PublicKey(o.borrower!),
      borrowerWsol: ata(o.wsolMint, o.borrower!), tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([ensureAta(lender, lender, o.wsolMint), ensureAta(lender, o.borrower!, o.wsolMint)])
    .transaction();
  return submitTransaction(connection, signer, tx);
}

export async function sendCloseOfferV2(signerLike: AnySigner, o: OfferV2, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const tx = await getProgramV2(signer, connection).methods.closeOffer().accountsPartial({ lender: signer.publicKey, offer: new PublicKey(o.publicKey) }).transaction();
  return submitTransaction(connection, signer, tx);
}

export async function sendCreateRequestV2(signerLike: AnySigner, requestId: bigint, terms: TermsInput, connection = getConnection()): Promise<{ request: PublicKey; signature: string }> {
  const signer = asSigner(signerLike);
  const borrower = signer.publicKey;
  const { usdc, wsol } = mints();
  const request = requestV2Pda(borrower, requestId);
  const tx = await getProgramV2(signer, connection)
    .methods.createRequest(bnU64(requestId), args(terms))
    .accountsPartial({
      borrower, request, usdcMint: usdc, wsolMint: wsol, requestVault: requestVaultV2Pda(request), borrowerWsol: ata(wsol, borrower), borrowerUsdc: ata(usdc, borrower),
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .preInstructions([ensureAta(borrower, borrower, usdc), ensureAta(borrower, borrower, wsol)])
    .transaction();
  return { request, signature: await submitTransaction(connection, signer, tx) };
}

export async function sendCancelRequestV2(signerLike: AnySigner, r: RequestV2, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const borrower = signer.publicKey;
  const request = new PublicKey(r.publicKey);
  const tx = await getProgramV2(signer, connection)
    .methods.cancelRequest()
    .accountsPartial({ borrower, request, requestVault: requestVaultV2Pda(request), borrowerWsol: ata(r.wsolMint, borrower), tokenProgram: TOKEN_PROGRAM_ID })
    .transaction();
  return submitTransaction(connection, signer, tx);
}

export async function sendFundRequestV2(signerLike: AnySigner, r: RequestV2, offerId: bigint, priceUpdate = PYTH_PRICE_UPDATE_ACCOUNT, connection = getConnection()): Promise<{ offer: PublicKey; signature: string }> {
  const signer = asSigner(signerLike);
  const lender = signer.publicKey;
  const request = new PublicKey(r.publicKey);
  const offer = offerV2Pda(lender, offerId);
  const tx = await getProgramV2(signer, connection)
    .methods.fundRequest(bnU64(offerId))
    .accountsPartial({
      lender, request, borrower: new PublicKey(r.borrower), priceUpdate, offer, wsolMint: new PublicKey(r.wsolMint), requestVault: requestVaultV2Pda(request),
      wsolVault: wsolVaultV2Pda(offer), lenderUsdc: ata(r.usdcMint, lender), borrowerUsdc: ata(r.usdcMint, r.borrower), tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([ensureAta(lender, r.borrower, r.usdcMint)])
    .transaction();
  return { offer, signature: await submitTransaction(connection, signer, tx) };
}

export async function sendCloseRequestV2(signerLike: AnySigner, r: RequestV2, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const tx = await getProgramV2(signer, connection).methods.closeRequest().accountsPartial({ borrower: signer.publicKey, request: new PublicKey(r.publicKey) }).transaction();
  return submitTransaction(connection, signer, tx);
}
