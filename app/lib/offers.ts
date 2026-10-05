import { AnchorProvider, Idl, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "@/idl/isolated_loan.json";
import {
  PROGRAM_ID,
  IS_LOCAL,
  DEVNET_USDC_MINT,
  NATIVE_WSOL_MINT,
} from "./constants";
import type { OfferAccount } from "./program";
import { offerStatusKey } from "./program";

export type StatusKey =
  | "open"
  | "filled"
  | "repaid"
  | "expired"
  | "liquidated"
  | "cancelled";

/** Plain, serialisable view of an on-chain offer. Amounts stay bigint. */
export type Offer = {
  publicKey: string;
  lender: string;
  borrower: string | null;
  offerId: bigint;
  usdcMint: string;
  wsolMint: string;
  principal: bigint;
  interestBps: number;
  durationSeconds: number;
  collateralAmount: bigint;
  maxLtvBps: number;
  liquidationLtvBps: number;
  startTs: number;
  expiryTs: number;
  status: StatusKey;
};

const DEFAULT_KEY = PublicKey.default.toBase58();

function readOnlyProgram(connection: Connection): Program<Idl> {
  // Reads need no signer; Anchor only asks the wallet for a public key.
  const provider = new AnchorProvider(
    connection,
    {
      publicKey: PublicKey.default,
      signTransaction: async (tx) => tx,
      signAllTransactions: async (txs) => txs,
    },
    { commitment: "confirmed" }
  );
  return new Program(
    { ...idl, address: PROGRAM_ID.toBase58() } as Idl,
    provider
  );
}

export function supportedOfferMints(
  a: Pick<OfferAccount, "usdcMint" | "wsolMint">,
  local = IS_LOCAL
): boolean {
  return (
    local ||
    (a.usdcMint.equals(DEVNET_USDC_MINT) && a.wsolMint.equals(NATIVE_WSOL_MINT))
  );
}

export function toOffer(publicKey: PublicKey, a: OfferAccount): Offer {
  if (!supportedOfferMints(a))
    throw new Error(
      "Unsupported offer: Devnet offers must use canonical Devnet USDC and native wrapped SOL."
    );
  const borrower = a.borrower.toBase58();
  return {
    publicKey: publicKey.toBase58(),
    lender: a.lender.toBase58(),
    borrower: borrower === DEFAULT_KEY ? null : borrower,
    offerId: BigInt(a.offerId.toString()),
    usdcMint: a.usdcMint.toBase58(),
    wsolMint: a.wsolMint.toBase58(),
    principal: BigInt(a.principal.toString()),
    interestBps: a.interestBps,
    durationSeconds: Number(a.durationSeconds.toString()),
    collateralAmount: BigInt(a.collateralAmount.toString()),
    maxLtvBps: a.maxLtvBps,
    liquidationLtvBps: a.liquidationLtvBps,
    startTs: Number(a.startTs.toString()),
    expiryTs: Number(a.expiryTs.toString()),
    status: offerStatusKey(a.status as Record<string, unknown>) as StatusKey,
  };
}

type OfferNamespace = {
  all: () => Promise<{ publicKey: PublicKey; account: OfferAccount }[]>;
  fetchNullable: (pk: PublicKey) => Promise<OfferAccount | null>;
};

function offerNamespace(connection: Connection): OfferNamespace {
  return (
    readOnlyProgram(connection).account as unknown as { offer: OfferNamespace }
  ).offer;
}

/** Every offer account that still exists on chain. Closed offers are gone. */
export async function fetchAllOffers(connection: Connection): Promise<Offer[]> {
  const rows = await offerNamespace(connection).all();
  return rows
    .filter((r) => supportedOfferMints(r.account))
    .map((r) => toOffer(r.publicKey, r.account))
    .sort((a, b) => Number(b.startTs || 0) - Number(a.startTs || 0));
}

/** One offer, or null once the lender has closed it. */
export async function fetchOfferByKey(
  connection: Connection,
  key: PublicKey
): Promise<Offer | null> {
  const a = await offerNamespace(connection).fetchNullable(key);
  return a ? toOffer(key, a) : null;
}
