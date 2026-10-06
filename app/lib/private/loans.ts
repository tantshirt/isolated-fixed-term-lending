// Private loans from the browser (story 10.1). Mirrors scripts/private/loan.ts.
import { AnchorProvider, BN, Program, utils, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import idl from "@/idl/private_loan.json";
import { DEVNET_USDC_MINT, NATIVE_WSOL_MINT, PYTH_PRICE_UPDATE_ACCOUNT } from "@/lib/constants";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { DELEGATION_PROGRAM_ID, ESPL_PROGRAM_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, ata, eataPda, permissionPda } from "./espl";
import { decodeLoanTerms, loanAnchorPda, loanTermsPda, type LoanTerms } from "./loan-codec";
import { advance, newReceipt, saveReceipt } from "./receipts";
import { PRIVATE_PROGRAM_ID, roomStatePda } from "./room-codec";
import { validateTransaction } from "./tx-validator";

const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
const USDC = DEVNET_USDC_MINT;
const WSOL = NATIVE_WSOL_MINT;
const enc = new TextEncoder();

export const LOAN_MESSAGE_PREFIX = "loan:";

export type TermsInput = {
  borrower: PublicKey;
  principal: bigint;
  interestBps: number;
  durationSeconds: number;
  collateralAmount: bigint;
  maxLtvBps: number;
  liquidationLtvBps: number;
};

function programFor(base: Connection, signer: LoanSigner) {
  return new Program(idl as Idl, new AnchorProvider(base, signer, { commitment: "confirmed" }));
}

const bufferPda = (account: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("buffer"), account.toBytes()], owner)[0];
const recordPda = (account: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("delegation"), account.toBytes()], DELEGATION_PROGRAM_ID)[0];
const metadataPda = (account: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("delegation-metadata"), account.toBytes()], DELEGATION_PROGRAM_ID)[0];

const toArgs = (t: TermsInput) => ({
  borrower: t.borrower,
  principal: new BN(t.principal.toString()),
  interestBps: t.interestBps,
  durationSeconds: new BN(t.durationSeconds),
  collateralAmount: new BN(t.collateralAmount.toString()),
  maxLtvBps: t.maxLtvBps,
  liquidationLtvBps: t.liquidationLtvBps,
});

/** The rollup reports program errors by name to members; map the common ones to plain words. */
export function explainLoanError(message: string): string {
  const table: [RegExp, string][] = [
    [/StalePrice|6004/, "The SOL price is more than 60 seconds old. Devnet refreshes it every few minutes; try again shortly."],
    [/StaleRevision|6026/, "The terms changed since you looked. Review the current revision and approve that one."],
    [/InsufficientCollateral|6028/, "At today's price the collateral is not enough for the maximum LTV."],
    [/LoanExpired|6029/, "The deadline has passed. The loan can only be claimed now."],
    [/LoanNotExpired|6030/, "The deadline has not passed yet."],
    [/WrongStatus|6025/, "This loan is no longer in that state. Refresh to see where it stands."],
    [/CompetingOfferAccepted|6031/, "You already accepted another offer in this room. The other lenders can cancel theirs."],
    [/insufficient funds|0x1\b/i, "Your private balance does not hold enough for this."],
  ];
  return table.find(([re]) => re.test(message))?.[1] ?? message;
}

async function sendEr(er: Connection, signer: LoanSigner, ix: Awaited<ReturnType<ReturnType<typeof programFor>["methods"][string]>>, intent: string, revision?: number) {
  const tx = new Transaction().add(await ix.instruction());
  tx.feePayer = signer.publicKey;
  validateTransaction(tx, { feePayer: signer.publicKey });
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  const signed = await signer.signTransaction(tx);
  const wallet = signer.publicKey.toBase58();
  const receipt = newReceipt(intent, "er", revision);
  const sig = await er.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  saveReceipt(wallet, advance(receipt, { erSignature: sig }));
  const res = await er.confirmTransaction(sig, "confirmed");
  if (res.value.err) {
    const t = await er.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    const named = t?.meta?.logMessages?.find((l) => l.includes("Error Code:")) ?? JSON.stringify(res.value.err);
    saveReceipt(wallet, advance(receipt, { erSignature: sig, stage: "failed", error: named }));
    throw new Error(explainLoanError(named));
  }
  saveReceipt(wallet, advance(receipt, { erSignature: sig, stage: "executed" }));
  return sig;
}

/** Base: loan anchor + custody token accounts + delegated eATAs; then the ER terms record. */
export async function proposeLoan(base: Connection, er: Connection, signer: LoanSigner, room: PublicKey, terms: TermsInput) {
  const program = programFor(base, signer);
  const loanIdBytes = crypto.getRandomValues(new Uint8Array(32));
  const loanId = utils.bytes.bs58.encode(loanIdBytes);
  const anchor = loanAnchorPda(loanIdBytes);
  const ue = eataPda(anchor, USDC);
  const we = eataPda(anchor, WSOL);
  const tx = new Transaction().add(
    await program.methods
      .createLoan([...loanIdBytes])
      .accountsPartial({
        lender: signer.publicKey,
        anchor,
        room,
        usdcMint: USDC,
        wsolMint: WSOL,
        usdcEata: ue,
        wsolEata: we,
        usdcBuffer: bufferPda(ue, ESPL_PROGRAM_ID),
        usdcRecord: recordPda(ue),
        usdcMetadata: metadataPda(ue),
        wsolBuffer: bufferPda(we, ESPL_PROGRAM_ID),
        wsolRecord: recordPda(we),
        wsolMetadata: metadataPda(we),
        esplProgram: ESPL_PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
      })
      .instruction(),
    await program.methods.delegateLoan([...loanIdBytes]).accountsPartial({ lender: signer.publicKey, anchor }).instruction(),
  );
  tx.feePayer = signer.publicKey;
  validateTransaction(tx, { feePayer: signer.publicKey });
  const { blockhash, lastValidBlockHeight } = await base.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  const signed = await signer.signTransaction(tx);
  const wallet = signer.publicKey.toBase58();
  const receipt = newReceipt("Set up the loan's private custody", "base");
  const sig = await base.sendRawTransaction(signed.serialize());
  saveReceipt(wallet, advance(receipt, { baseSignature: sig }));
  await base.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  saveReceipt(wallet, advance(receipt, { baseSignature: sig, stage: "settled" }));
  for (let i = 0; i < 30 && !(await er.getAccountInfo(anchor)); i++) await new Promise((r) => setTimeout(r, 1000));

  await sendEr(
    er,
    signer,
    program.methods.proposeTerms(toArgs(terms)).accountsPartial({
      lender: signer.publicKey,
      anchor,
      room,
      roomState: roomStatePda(room),
      terms: loanTermsPda(anchor),
      termsPermission: permissionPda(loanTermsPda(anchor)),
      vault: EPHEMERAL_VAULT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
      permissionProgram: PERMISSION_PROGRAM_ID,
    }),
    "Propose loan terms",
    1,
  );
  return { loanId, anchor };
}

export function loanFromId(loanId: string): PublicKey {
  return loanAnchorPda(utils.bytes.bs58.decode(loanId));
}

export async function readLoan(er: Connection, anchor: PublicKey): Promise<LoanTerms | null> {
  const i = await er.getAccountInfo(loanTermsPda(anchor));
  return i ? decodeLoanTerms(i.data) : null;
}

const lenderAccounts = (lender: PublicKey, anchor: PublicKey) => ({
  lender,
  anchor,
  terms: loanTermsPda(anchor),
  lenderUsdc: ata(lender, USDC),
  loanUsdc: ata(anchor, USDC),
});

const roomDealPda = (room: PublicKey) => PublicKey.findProgramAddressSync([enc.encode("room-deal"), room.toBytes()], PRIVATE_PROGRAM_ID)[0];

const borrowerAccounts = (t: LoanTerms, anchor: PublicKey) => ({
  borrower: t.borrower,
  anchor,
  terms: loanTermsPda(anchor),
  borrowerUsdc: ata(t.borrower, USDC),
  borrowerWsol: ata(t.borrower, WSOL),
  loanUsdc: ata(anchor, USDC),
  loanWsol: ata(anchor, WSOL),
  lenderUsdc: ata(t.lender, USDC),
  priceUpdate: PYTH_PRICE_UPDATE_ACCOUNT,
  // Only acceptance uses the room deal lock; Anchor treats null as "not provided".
  deal: null as unknown as PublicKey,
  dealPermission: null as unknown as PublicKey,
  vault: null as unknown as PublicKey,
  magicProgram: null as unknown as PublicKey,
  permissionProgram: null as unknown as PublicKey,
});

export async function editLoan(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, terms: TermsInput, nextRevision: number) {
  const p = programFor(base, signer);
  return sendEr(er, signer, p.methods.editTerms(toArgs(terms)).accountsPartial({ lender: signer.publicKey, anchor, terms: loanTermsPda(anchor) }), "Change loan terms", nextRevision);
}

export async function fundLoan(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, revision: number) {
  const p = programFor(base, signer);
  return sendEr(er, signer, p.methods.fundLoan(revision).accountsPartial(lenderAccounts(signer.publicKey, anchor)), `Lock USDC (revision ${revision})`, revision);
}

export async function cancelLoan(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, funded = true) {
  const p = programFor(base, signer);
  const accounts = lenderAccounts(signer.publicKey, anchor);
  // An unfunded proposal moves no tokens, and a lender with no private balance has no
  // USDC account in the rollup, which the ER rejects as writable. The handler only reads
  // the lender's account when funded, so a draft passes the loan's own (delegated) one.
  if (!funded) accounts.lenderUsdc = accounts.loanUsdc;
  return sendEr(er, signer, p.methods.cancelLoan().accountsPartial(accounts), "Cancel offer");
}

export async function acceptLoan(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, t: LoanTerms, room: PublicKey) {
  const p = programFor(base, signer);
  const deal = roomDealPda(room);
  return sendEr(
    er,
    signer,
    p.methods.acceptLoan(t.revision).accountsPartial({
      ...borrowerAccounts(t, anchor),
      deal,
      dealPermission: permissionPda(deal),
      vault: EPHEMERAL_VAULT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
      permissionProgram: PERMISSION_PROGRAM_ID,
    }),
    `Lock wSOL and borrow (revision ${t.revision})`,
    t.revision,
  );
}

export async function repayLoan(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, t: LoanTerms) {
  const p = programFor(base, signer);
  return sendEr(er, signer, p.methods.repayLoan().accountsPartial(borrowerAccounts(t, anchor)), "Repay");
}

export async function claimLoan(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, t: LoanTerms) {
  const p = programFor(base, signer);
  return sendEr(
    er,
    signer,
    p.methods.claimExpired().accountsPartial({ anchor, terms: loanTermsPda(anchor), loanWsol: ata(anchor, WSOL), lenderWsol: ata(t.lender, WSOL) }),
    "Claim collateral",
  );
}

/** Loan ids announced in a room thread, newest first. */
export function loansInThread(bodies: string[]): string[] {
  const out: string[] = [];
  for (const b of bodies) if (b.startsWith(LOAN_MESSAGE_PREFIX)) out.unshift(b.slice(LOAN_MESSAGE_PREFIX.length).trim());
  return [...new Set(out)];
}
