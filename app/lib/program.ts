import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "@/idl/isolated_loan.json";
import { RPC_URL, WS_URL, PROGRAM_ID } from "./constants";
import { asSigner, type LoanSigner } from "./keypair-wallet";

import { rpcFetch } from "./rpc-fetch";

export type IsolatedLoan = Program<Idl>;

export function getConnection(endpoint = RPC_URL): Connection {
  return new Connection(endpoint, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: rpcFetch,
    wsEndpoint: WS_URL,
  });
}

export function getProgram(
  signer: Keypair | LoanSigner,
  endpoint = RPC_URL
): IsolatedLoan {
  const connection = getConnection(endpoint);
  const wallet = asSigner(signer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program(
    { ...idl, address: PROGRAM_ID.toBase58() } as Idl,
    provider
  );
}

export function bnU64(value: bigint | number): BN {
  return new BN(value.toString());
}

export type OfferAccount = {
  lender: PublicKey;
  borrower: PublicKey;
  offerId: BN;
  usdcMint: PublicKey;
  wsolMint: PublicKey;
  principal: BN;
  interestBps: number;
  durationSeconds: BN;
  collateralAmount: BN;
  maxLtvBps: number;
  liquidationLtvBps: number;
  startTs: BN;
  expiryTs: BN;
  status: Record<string, unknown>;
  bump: number;
};

export type RequestAccount = {
  borrower: PublicKey;
  requestId: BN;
  usdcMint: PublicKey;
  wsolMint: PublicKey;
  principal: BN;
  interestBps: number;
  durationSeconds: BN;
  collateralAmount: BN;
  maxLtvBps: number;
  liquidationLtvBps: number;
  createdTs: BN;
  status: Record<string, unknown>;
  lender: PublicKey;
  offer: PublicKey;
  bump: number;
};

export function offerStatusKey(status: Record<string, unknown>): string {
  return Object.keys(status)[0] ?? "unknown";
}

export async function fetchOffer(
  program: IsolatedLoan,
  offerPubkey: PublicKey
): Promise<{ publicKey: PublicKey; account: OfferAccount }> {
  const account = await (
    program.account as {
      offer: { fetch: (pk: PublicKey) => Promise<OfferAccount> };
    }
  ).offer.fetch(offerPubkey);
  return { publicKey: offerPubkey, account };
}
