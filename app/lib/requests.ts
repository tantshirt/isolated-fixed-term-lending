import { Connection, PublicKey } from "@solana/web3.js";
import type { RequestAccount } from "./program";
import { offerStatusKey } from "./program";
import { readOnlyProgram, supportedOfferMints } from "./offers";

export type RequestStatusKey = "open" | "funded" | "cancelled";

/** Plain, serialisable view of a borrower's public request. Amounts stay bigint. */
export type LoanRequest = {
  publicKey: string;
  borrower: string;
  requestId: bigint;
  usdcMint: string;
  wsolMint: string;
  principal: bigint;
  interestBps: number;
  durationSeconds: number;
  collateralAmount: bigint;
  maxLtvBps: number;
  liquidationLtvBps: number;
  createdTs: number;
  status: RequestStatusKey;
  /** Set once funded. */
  lender: string | null;
  /** The filled offer created at funding. */
  offer: string | null;
};

const DEFAULT_KEY = PublicKey.default.toBase58();
const orNull = (k: PublicKey) => {
  const s = k.toBase58();
  return s === DEFAULT_KEY ? null : s;
};

export function toRequest(publicKey: PublicKey, a: RequestAccount): LoanRequest {
  if (!supportedOfferMints(a))
    throw new Error(
      "Unsupported request: Devnet requests must use canonical Devnet USDC and native wrapped SOL."
    );
  return {
    publicKey: publicKey.toBase58(),
    borrower: a.borrower.toBase58(),
    requestId: BigInt(a.requestId.toString()),
    usdcMint: a.usdcMint.toBase58(),
    wsolMint: a.wsolMint.toBase58(),
    principal: BigInt(a.principal.toString()),
    interestBps: a.interestBps,
    durationSeconds: Number(a.durationSeconds.toString()),
    collateralAmount: BigInt(a.collateralAmount.toString()),
    maxLtvBps: a.maxLtvBps,
    liquidationLtvBps: a.liquidationLtvBps,
    createdTs: Number(a.createdTs.toString()),
    status: offerStatusKey(a.status) as RequestStatusKey,
    lender: orNull(a.lender),
    offer: orNull(a.offer),
  };
}

type RequestNamespace = {
  all: () => Promise<{ publicKey: PublicKey; account: RequestAccount }[]>;
  fetchNullable: (pk: PublicKey) => Promise<RequestAccount | null>;
};

function requestNamespace(connection: Connection): RequestNamespace {
  return (
    readOnlyProgram(connection).account as unknown as {
      loanRequest: RequestNamespace;
    }
  ).loanRequest;
}

export const byNewest = (a: LoanRequest, b: LoanRequest) => b.createdTs - a.createdTs;

/** Every request account that still exists. Closed requests are gone. */
export async function fetchAllRequests(
  connection: Connection
): Promise<LoanRequest[]> {
  const rows = await requestNamespace(connection).all();
  return rows
    .filter((r) => supportedOfferMints(r.account))
    .map((r) => toRequest(r.publicKey, r.account))
    .sort(byNewest);
}

/** One request, or null once the borrower has closed it. */
export async function fetchRequestByKey(
  connection: Connection,
  key: PublicKey
): Promise<LoanRequest | null> {
  const a = await requestNamespace(connection).fetchNullable(key);
  return a ? toRequest(key, a) : null;
}

/** Decodes a raw account from a subscription. Null for other mints or layouts. */
export function decodeRequest(
  connection: Connection,
  key: PublicKey,
  data: Buffer
): LoanRequest | null {
  try {
    const a = readOnlyProgram(connection).coder.accounts.decode<RequestAccount>(
      "loanRequest",
      data
    );
    return supportedOfferMints(a) ? toRequest(key, a) : null;
  } catch {
    return null;
  }
}
