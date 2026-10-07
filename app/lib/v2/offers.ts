import type { BN } from "@coral-xyz/anchor";
import { PublicKey, type Connection } from "@solana/web3.js";
import { EarlyRepayment, type Ledger, type TermsV2 } from "../loan-math-v2";
import { OFFER_V2_OFFSETS, PROGRAM_V2_ID, REQUEST_V2_OFFSETS, v2Coder } from "./program";

export type StatusV2 = "open" | "active" | "repaid" | "liquidated" | "overdueLiquidated" | "pricedRecovered" | "terminalClaimed" | "cancelled" | "refinanced";
export type RequestStatusV2 = "open" | "funded" | "cancelled";

/** Plain, serialisable V2 offer. Amounts stay bigint. */
export type OfferV2 = {
  generation: "v2";
  publicKey: string;
  version: number;
  originLender: string;
  currentLender: string;
  borrower: string | null;
  restrictedBorrower: string | null;
  offerId: bigint;
  usdcMint: string;
  wsolMint: string;
  terms: TermsV2;
  collateralRequired: bigint;
  collateralLocked: bigint;
  maxLtvBps: number;
  liquidationLtvBps: number;
  status: StatusV2;
  ledger: Ledger;
  shortfall: bigint;
  settledTs: number;
};

export type RequestV2 = {
  generation: "v2";
  publicKey: string;
  borrower: string;
  requestId: bigint;
  usdcMint: string;
  wsolMint: string;
  terms: TermsV2;
  collateralAmount: bigint;
  maxLtvBps: number;
  liquidationLtvBps: number;
  createdTs: number;
  status: RequestStatusV2;
  lender: string | null;
  offer: string | null;
};

type RawTerms = {
  principal: BN; interestBps: number; duration: BN; earlyRepayment: number; minInterestBps: number;
  graceSeconds: BN; lateFeeBps: number; annualCeilingBps: number; startTs: BN;
};
type RawLedger = {
  outstandingPrincipal: BN; interestAccrued: BN; interestPaid: BN; accrualRemainder: BN; lastAccrualTs: BN;
  lateFeeAssessed: BN; lateFeePaid: BN; lateFeeChecked: boolean;
};

const big = (v: BN) => BigInt(v.toString());
const num = (v: BN) => Number(v.toString());
const key = (k: PublicKey) => (k.equals(PublicKey.default) ? null : k.toBase58());
const variant = (e: Record<string, unknown>) => {
  const k = Object.keys(e)[0] ?? "";
  return k.charAt(0).toLowerCase() + k.slice(1);
};

function terms(t: RawTerms): TermsV2 {
  return {
    principal: big(t.principal),
    interestBps: t.interestBps,
    duration: num(t.duration),
    startTs: num(t.startTs),
    earlyRepayment: t.earlyRepayment === 1 ? EarlyRepayment.ProRata : EarlyRepayment.FullTerm,
    minInterestBps: t.minInterestBps,
    graceSeconds: num(t.graceSeconds),
    lateFeeBps: t.lateFeeBps,
    annualCeilingBps: t.annualCeilingBps,
  };
}

export function decodeOfferV2(publicKey: PublicKey, data: Buffer): OfferV2 {
  const a = v2Coder.decode("offerV2", data);
  const l = a.ledger as RawLedger;
  return {
    generation: "v2",
    publicKey: publicKey.toBase58(),
    version: a.version,
    originLender: a.originLender.toBase58(),
    currentLender: a.currentLender.toBase58(),
    borrower: key(a.borrower),
    restrictedBorrower: key(a.restrictedBorrower),
    offerId: big(a.offerId),
    usdcMint: a.usdcMint.toBase58(),
    wsolMint: a.wsolMint.toBase58(),
    terms: terms(a.terms),
    collateralRequired: big(a.collateralRequired),
    collateralLocked: big(a.collateralLocked),
    maxLtvBps: a.maxLtvBps,
    liquidationLtvBps: a.liquidationLtvBps,
    status: variant(a.status) as StatusV2,
    ledger: {
      outstandingPrincipal: big(l.outstandingPrincipal),
      interestAccrued: big(l.interestAccrued),
      interestPaid: big(l.interestPaid),
      accrualRemainder: big(l.accrualRemainder),
      lastAccrualTs: num(l.lastAccrualTs),
      lateFeeAssessed: big(l.lateFeeAssessed),
      lateFeePaid: big(l.lateFeePaid),
      lateFeeChecked: l.lateFeeChecked,
    },
    shortfall: big(a.shortfall),
    settledTs: num(a.settledTs),
  };
}

export function decodeRequestV2(publicKey: PublicKey, data: Buffer): RequestV2 {
  const a = v2Coder.decode("requestV2", data);
  return {
    generation: "v2",
    publicKey: publicKey.toBase58(),
    borrower: a.borrower.toBase58(),
    requestId: big(a.requestId),
    usdcMint: a.usdcMint.toBase58(),
    wsolMint: a.wsolMint.toBase58(),
    terms: terms(a.terms),
    collateralAmount: big(a.collateralAmount),
    maxLtvBps: a.maxLtvBps,
    liquidationLtvBps: a.liquidationLtvBps,
    createdTs: num(a.createdTs),
    status: variant(a.status) as RequestStatusV2,
    lender: key(a.lender),
    offer: key(a.offer),
  };
}

const discriminator = (name: "offerV2" | "requestV2") => v2Coder.memcmp(name);

/** All V2 offers, optionally filtered to one wallet's side. */
export async function fetchOffersV2(connection: Connection, filter?: { side: keyof typeof OFFER_V2_OFFSETS; wallet: string }): Promise<OfferV2[]> {
  const filters = [{ memcmp: discriminator("offerV2") }];
  if (filter) filters.push({ memcmp: { offset: OFFER_V2_OFFSETS[filter.side], bytes: filter.wallet } });
  const rows = await connection.getProgramAccounts(PROGRAM_V2_ID, { filters });
  return rows.map((r) => decodeOfferV2(r.pubkey, r.account.data as Buffer));
}

export async function fetchRequestsV2(connection: Connection, borrower?: string): Promise<RequestV2[]> {
  const filters = [{ memcmp: discriminator("requestV2") }];
  if (borrower) filters.push({ memcmp: { offset: REQUEST_V2_OFFSETS.borrower, bytes: borrower } });
  const rows = await connection.getProgramAccounts(PROGRAM_V2_ID, { filters });
  return rows.map((r) => decodeRequestV2(r.pubkey, r.account.data as Buffer));
}

export async function fetchOfferV2(connection: Connection, offer: PublicKey): Promise<OfferV2 | null> {
  const info = await connection.getAccountInfo(offer);
  return info && info.owner.equals(PROGRAM_V2_ID) ? decodeOfferV2(offer, info.data as Buffer) : null;
}

export const offerV2Href = (o: Pick<OfferV2, "originLender" | "offerId">) => `/devnet/loans/${o.originLender}/${o.offerId}`;
export const requestV2Href = (r: Pick<RequestV2, "borrower" | "requestId">) => `/devnet/loans/requests/${r.borrower}/${r.requestId}`;
