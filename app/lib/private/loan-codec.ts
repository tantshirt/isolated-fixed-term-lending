// ER-only `LoanTerms` layout from programs/private_loan/src/loan.rs (Borsh, no discriminator).
import { PublicKey } from "@solana/web3.js";
import { PRIVATE_PROGRAM_ID } from "./room-codec";

export const LOAN_STATUS = ["draft", "funded", "active", "repaid", "expired", "cancelled", "liquidated"] as const;
export type LoanStatus = (typeof LOAN_STATUS)[number];

export const LOAN_STATUS_LABEL: Record<LoanStatus, string> = {
  draft: "Proposed",
  funded: "Funded, waiting for borrower",
  active: "Waiting for repayment",
  repaid: "Repaid",
  expired: "Expired",
  cancelled: "Cancelled",
  liquidated: "Liquidated",
};

export type LoanTerms = {
  lender: PublicKey;
  borrower: PublicKey;
  principal: bigint;
  interestBps: number;
  durationSeconds: number;
  collateralAmount: bigint;
  maxLtvBps: number;
  liquidationLtvBps: number;
  revision: number;
  fundedRevision: number;
  acceptedRevision: number;
  status: LoanStatus;
  startTs: number;
  expiryTs: number;
};

const enc = new TextEncoder();
export const loanAnchorPda = (loanId: Uint8Array) =>
  PublicKey.findProgramAddressSync([enc.encode("loan"), loanId], PRIVATE_PROGRAM_ID)[0];
export const loanTermsPda = (anchor: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("loan-terms"), anchor.toBytes()], PRIVATE_PROGRAM_ID)[0];

export function decodeLoanTerms(data: Uint8Array): LoanTerms {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 1;
  const key = () => {
    const k = new PublicKey(data.slice(o, o + 32));
    o += 32;
    return k;
  };
  const u64 = () => {
    const x = v.getBigUint64(o, true);
    o += 8;
    return x;
  };
  const i64 = () => {
    const x = Number(v.getBigInt64(o, true));
    o += 8;
    return x;
  };
  const u16 = () => {
    const x = v.getUint16(o, true);
    o += 2;
    return x;
  };
  const u32 = () => {
    const x = v.getUint32(o, true);
    o += 4;
    return x;
  };
  const lender = key();
  const borrower = key();
  const principal = u64();
  const interestBps = u16();
  const durationSeconds = i64();
  const collateralAmount = u64();
  const maxLtvBps = u16();
  const liquidationLtvBps = u16();
  const revision = u32();
  const fundedRevision = u32();
  const acceptedRevision = u32();
  const status = LOAN_STATUS[data[o]] ?? "draft";
  o += 1;
  return {
    lender,
    borrower,
    principal,
    interestBps,
    durationSeconds,
    collateralAmount,
    maxLtvBps,
    liquidationLtvBps,
    revision,
    fundedRevision,
    acceptedRevision,
    status,
    startTs: i64(),
    expiryTs: i64(),
  };
}
