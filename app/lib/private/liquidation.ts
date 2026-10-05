// Open liquidation through public quotes (story 12.1). A liquidator never reads
// the loan: they see a short-lived quote (debt to pay, collateral payout,
// expiry), fund it from a private balance, and later collect a payout or refund.
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import idl from "@/idl/private_loan.json";
import { DEVNET_USDC_MINT, NATIVE_WSOL_MINT, PYTH_PRICE_UPDATE_ACCOUNT } from "@/lib/constants";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { MAGIC_PROGRAM_ID, ata } from "./espl";
import { loanTermsPda } from "./loan-codec";
import { advance, newReceipt, saveReceipt } from "./receipts";
import { PRIVATE_PROGRAM_ID } from "./room-codec";
import { validateTransaction } from "./tx-validator";

const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
export const HYDRA_EPHEMERAL = new PublicKey("eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf");
const enc = new TextEncoder();
export const QUOTE_LEN = 31 + 4 * 61;
export const poolPda = () => PublicKey.findProgramAddressSync([enc.encode("liq-pool")], PRIVATE_PROGRAM_ID)[0];
export const quotePda = (loan: PublicKey) => PublicKey.findProgramAddressSync([enc.encode("quote"), loan.toBytes()], PRIVATE_PROGRAM_ID)[0];
export const watchCrankPda = (loan: PublicKey, loanId: Uint8Array) =>
  PublicKey.findProgramAddressSync([enc.encode("crank"), loan.toBytes(), loanId], HYDRA_EPHEMERAL)[0];

export type Ticket = { liquidator: PublicKey; paidIn: bigint; revision: number; minPayout: bigint; payout: bigint; state: "funded" | "won" | "refunded" | "paid" };
export type Quote = { address: PublicKey; revision: number; debt: bigint; payout: bigint; expiresAt: number; state: "open" | "executed" | "withdrawn"; tickets: Ticket[] };

export function decodeQuote(address: PublicKey, d: Uint8Array): Quote | null {
  if (d[0] !== 1) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const tickets: Ticket[] = [];
  for (let i = 0; i < Math.min(d[30], 4); i++) {
    const o = 31 + i * 61;
    tickets.push({
      liquidator: new PublicKey(d.slice(o, o + 32)),
      paidIn: v.getBigUint64(o + 32, true),
      revision: v.getUint32(o + 40, true),
      minPayout: v.getBigUint64(o + 44, true),
      payout: v.getBigUint64(o + 52, true),
      state: (["funded", "won", "refunded", "paid"] as const)[d[o + 60]] ?? "funded",
    });
  }
  return {
    address,
    revision: v.getUint32(1, true),
    debt: v.getBigUint64(5, true),
    payout: v.getBigUint64(13, true),
    expiresAt: Number(v.getBigInt64(21, true)),
    state: (["open", "executed", "withdrawn"] as const)[d[29]] ?? "open",
    tickets,
  };
}

/** All quotes in the rollup. Quotes are public there; loans are not. */
export async function listQuotes(er: Connection): Promise<Quote[]> {
  const accounts = await er.getProgramAccounts(PRIVATE_PROGRAM_ID, { filters: [{ dataSize: QUOTE_LEN }] });
  return accounts.map((a) => decodeQuote(a.pubkey, a.account.data)).filter((q): q is Quote => !!q);
}

const programFor = (base: Connection, signer: LoanSigner) => new Program(idl as Idl, new AnchorProvider(base, signer, { commitment: "confirmed" }));

async function sendEr(er: Connection, signer: LoanSigner, tx: Transaction, intent: string) {
  tx.feePayer = signer.publicKey;
  validateTransaction(tx, { feePayer: signer.publicKey });
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  const signed = await signer.signTransaction(tx);
  const receipt = newReceipt(intent, "er");
  const sig = await er.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  const res = await er.confirmTransaction(sig, "confirmed");
  saveReceipt(signer.publicKey.toBase58(), advance(receipt, { erSignature: sig, stage: res.value.err ? "failed" : "executed" }));
  if (res.value.err) throw new Error("The private rollup rejected this. The quote may have expired or moved to a new revision.");
  return sig;
}

export async function fundQuote(base: Connection, er: Connection, signer: LoanSigner, quote: Quote) {
  const p = programFor(base, signer);
  const pool = poolPda();
  return sendEr(
    er,
    signer,
    new Transaction().add(
      await p.methods
        .fundQuote(quote.revision)
        .accountsPartial({ liquidator: signer.publicKey, quote: quote.address, pool, liquidatorUsdc: ata(signer.publicKey, DEVNET_USDC_MINT), poolUsdc: ata(pool, DEVNET_USDC_MINT) })
        .instruction(),
    ),
    `Fund a liquidation quote (${Number(quote.debt) / 1e6} USDC)`,
  );
}

export async function settleTicket(base: Connection, er: Connection, signer: LoanSigner, quote: Quote) {
  const p = programFor(base, signer);
  const pool = poolPda();
  return sendEr(
    er,
    signer,
    new Transaction().add(
      await p.methods
        .settleTicket()
        .accountsPartial({
          liquidator: signer.publicKey,
          quote: quote.address,
          pool,
          liquidatorUsdc: ata(signer.publicKey, DEVNET_USDC_MINT),
          liquidatorWsol: ata(signer.publicKey, NATIVE_WSOL_MINT),
          poolUsdc: ata(pool, DEVNET_USDC_MINT),
          poolWsol: ata(pool, NATIVE_WSOL_MINT),
        })
        .instruction(),
    ),
    "Collect a liquidation payout or refund",
  );
}

/** Schedules the loan's automatic watch (expiry and liquidation). Anyone may; the app does it after acceptance. */
export async function scheduleWatch(base: Connection, er: Connection, signer: LoanSigner, loan: PublicKey, loanId: Uint8Array) {
  const crank = watchCrankPda(loan, loanId);
  if (await er.getAccountInfo(crank)) return null;
  const p = programFor(base, signer);
  return sendEr(
    er,
    signer,
    new Transaction().add(
      await p.methods
        .scheduleWatch()
        .accountsPartial({
          anchor: loan,
          terms: loanTermsPda(loan),
          quote: quotePda(loan),
          pool: poolPda(),
          priceUpdate: PYTH_PRICE_UPDATE_ACCOUNT,
          crank,
          vault: EPHEMERAL_VAULT_ID,
          magicProgram: MAGIC_PROGRAM_ID,
          hydraProgram: HYDRA_EPHEMERAL,
        })
        .instruction(),
    ),
    "Turn on automatic expiry and liquidation checks",
  );
}

export async function watchStatus(er: Connection, loan: PublicKey, loanId: Uint8Array) {
  const [crank, quote] = await Promise.all([er.getAccountInfo(watchCrankPda(loan, loanId)), er.getAccountInfo(quotePda(loan))]);
  return { watching: !!crank, quote: quote ? decodeQuote(quotePda(loan), quote.data) : null };
}
