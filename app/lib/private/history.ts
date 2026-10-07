/**
 * Private repayment history (Story 26.7), mirroring private_loan_v2 `history.rs`.
 *
 * - `CreditHistory` is ER-only at ["credit-history", borrower], Borsh with no discriminator. Only
 *   the borrower reads it, through their own TEE session.
 * - `HistoryAttestation` is a base-layer Anchor account at ["credit-attestation", borrower], written
 *   only by the program's post-commit action when the borrower chooses to publish. Publishing makes
 *   these counts public.
 *
 * Export is browser-only: the file is built here and saved by the browser. It never passes through
 * a server, Convex or telemetry.
 */
import { PublicKey } from "@solana/web3.js";
import { PRIVATE_V2_ID } from "./v2-codec";

export const HISTORY_SEED = Buffer.from("credit-history");
export const HISTORY_ATTESTATION_SEED = Buffer.from("credit-attestation");
export const MAX_HISTORY_LOANS = 32;
/** 1 + 32 + 5 × 4 + 8 + 2 + 32 × 32 + 1. */
export const CREDIT_HISTORY_LEN = 1 + 32 + 20 + 8 + 2 + 32 * MAX_HISTORY_LOANS + 1;
/** sha256("account:HistoryAttestation")[..8]. */
export const HISTORY_ATTESTATION_DISCRIMINATOR = Uint8Array.from([181, 148, 111, 79, 135, 53, 102, 106]);
export const HISTORY_ATTESTATION_LEN = 8 + 1 + 32 + 20 + 2 + 8 + 8 + 1;

export const historyPda = (borrower: PublicKey) => PublicKey.findProgramAddressSync([HISTORY_SEED, borrower.toBuffer()], PRIVATE_V2_ID)[0];
export const historyAttestationPda = (borrower: PublicKey) => PublicKey.findProgramAddressSync([HISTORY_ATTESTATION_SEED, borrower.toBuffer()], PRIVATE_V2_ID)[0];

export type CreditHistory = {
  version: number;
  borrower: string;
  onTime: number;
  late: number;
  liquidated: number;
  defaulted: number;
  refinanced: number;
  lastSettledAt: number;
  /** Loan anchors counted, `counted[..count]`. */
  loans: string[];
  bump: number;
};

export type HistoryAttestation = {
  version: number;
  borrower: string;
  repaid: number;
  onTime: number;
  late: number;
  liquidated: number;
  defaulted: number;
  loansCounted: number;
  rollupSlot: bigint;
  attestedAt: number;
  bump: number;
};

export const repaidOf = (h: Pick<CreditHistory, "onTime" | "late">) => h.onTime + h.late;

/** Null for anything that is not a well-formed history record. */
export function decodeCreditHistory(raw: Uint8Array): CreditHistory | null {
  if (raw.length < CREDIT_HISTORY_LEN) return null;
  const b = Buffer.from(raw);
  const key = (o: number) => new PublicKey(b.subarray(o, o + 32)).toBase58();
  const count = b.readUInt16LE(61);
  if (count > MAX_HISTORY_LOANS) return null;
  const loans: string[] = [];
  for (let i = 0; i < count; i++) loans.push(key(63 + 32 * i));
  return {
    version: b[0],
    borrower: key(1),
    onTime: b.readUInt32LE(33),
    late: b.readUInt32LE(37),
    liquidated: b.readUInt32LE(41),
    defaulted: b.readUInt32LE(45),
    refinanced: b.readUInt32LE(49),
    lastSettledAt: Number(b.readBigInt64LE(53)),
    loans,
    bump: b[63 + 32 * MAX_HISTORY_LOANS],
  };
}

export function decodeHistoryAttestation(raw: Uint8Array): HistoryAttestation | null {
  if (raw.length < HISTORY_ATTESTATION_LEN) return null;
  const b = Buffer.from(raw);
  if (!HISTORY_ATTESTATION_DISCRIMINATOR.every((x, i) => b[i] === x)) return null;
  return {
    version: b[8],
    borrower: new PublicKey(b.subarray(9, 41)).toBase58(),
    repaid: b.readUInt32LE(41),
    onTime: b.readUInt32LE(45),
    late: b.readUInt32LE(49),
    liquidated: b.readUInt32LE(53),
    defaulted: b.readUInt32LE(57),
    loansCounted: b.readUInt16LE(61),
    rollupSlot: b.readBigUInt64LE(63),
    attestedAt: Number(b.readBigInt64LE(71)),
    bump: b[79],
  };
}

export const EXPORT_NOTE = "Activity record of your own private loans, built in your browser from the private rollup. Not a credit report, and not tax advice.";

/** The export as JSON text: counts and the counted loan anchors, nothing else. */
export function historyJson(h: CreditHistory, readAt: number): string {
  return JSON.stringify(
    {
      kind: "zenlo-repayment-history",
      version: h.version,
      borrower: h.borrower,
      readAt: new Date(readAt * 1000).toISOString(),
      counts: { repaid: repaidOf(h), onTime: h.onTime, late: h.late, liquidated: h.liquidated, defaulted: h.defaulted, refinanced: h.refinanced },
      lastSettledAt: h.lastSettledAt > 0 ? new Date(h.lastSettledAt * 1000).toISOString() : null,
      loans: h.loans,
      note: EXPORT_NOTE,
    },
    null,
    2,
  );
}

/** The export as CSV: one counts row block, then one row per counted loan anchor. */
export function historyCsv(h: CreditHistory, readAt: number): string {
  const rows = [
    `# ${EXPORT_NOTE}`,
    "borrower,read_at,repaid,on_time,late,liquidated,defaulted,refinanced,last_settled_at",
    [h.borrower, new Date(readAt * 1000).toISOString(), repaidOf(h), h.onTime, h.late, h.liquidated, h.defaulted, h.refinanced, h.lastSettledAt > 0 ? new Date(h.lastSettledAt * 1000).toISOString() : ""].join(","),
    "",
    "loan_anchor",
    ...h.loans,
  ];
  return rows.join("\n") + "\n";
}
