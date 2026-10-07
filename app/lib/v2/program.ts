import { AnchorProvider, type Idl, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, type Keypair } from "@solana/web3.js";
import idl from "@/idl/isolated_loan_v2.json";
import { IS_LOCAL } from "../constants";
import { asSigner, type LoanSigner } from "../keypair-wallet";
import { getConnection } from "../program";

/** isolated_loan_v2 (Stories 21.1, 21.2). */
export const PROGRAM_V2_ID = new PublicKey(process.env.NEXT_PUBLIC_LOAN_V2_PROGRAM_ID || "8hxagcQkw1Km6PWZgpA92qUnqvnFufC7tx2jvxf9Ko8m");

/**
 * New loans go to V2 only where the program is deployed. On Devnet that is switched on with
 * NEXT_PUBLIC_V2_LIVE=1 after the deploy is verified; until then the app keeps creating V1 offers.
 */
export const V2_LIVE = IS_LOCAL || process.env.NEXT_PUBLIC_V2_LIVE === "1";

const IDL = { ...(idl as Idl), address: PROGRAM_V2_ID.toBase58() } as Idl;

export function getProgramV2(signer: Keypair | LoanSigner, connection: Connection = getConnection()): Program<Idl> {
  return new Program(IDL, new AnchorProvider(connection, asSigner(signer), { commitment: "confirmed" }));
}

export function readOnlyProgramV2(connection: Connection = getConnection()): Program<Idl> {
  const wallet = { publicKey: PublicKey.default, signTransaction: async <T,>(t: T) => t, signAllTransactions: async <T,>(t: T[]) => t };
  return new Program(IDL, new AnchorProvider(connection, wallet, { commitment: "confirmed" }));
}

/** Account coder with the program's camelCase field names. Building it opens no connection. */
export const v2Coder = readOnlyProgramV2(new Connection("http://127.0.0.1:8899")).coder.accounts;

export const OFFER_V2_SEED = Buffer.from("offer-v2");
export const USDC_VAULT_V2_SEED = Buffer.from("usdc-vault-v2");
export const WSOL_VAULT_V2_SEED = Buffer.from("wsol-vault-v2");
export const REQUEST_V2_SEED = Buffer.from("request-v2");
export const REQUEST_WSOL_V2_SEED = Buffer.from("request-wsol-v2");

const u64le = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_V2_ID)[0];

export const offerV2Pda = (originLender: PublicKey, offerId: bigint) => pda([OFFER_V2_SEED, originLender.toBuffer(), u64le(offerId)]);
export const usdcVaultV2Pda = (offer: PublicKey) => pda([USDC_VAULT_V2_SEED, offer.toBuffer()]);
export const wsolVaultV2Pda = (offer: PublicKey) => pda([WSOL_VAULT_V2_SEED, offer.toBuffer()]);
export const requestV2Pda = (borrower: PublicKey, requestId: bigint) => pda([REQUEST_V2_SEED, borrower.toBuffer(), u64le(requestId)]);
export const requestVaultV2Pda = (request: PublicKey) => pda([REQUEST_WSOL_V2_SEED, request.toBuffer()]);
/** Governance `CollateralConfig` for a non-wSOL collateral mint (Story 26.2). */
export const COLLATERAL_CONFIG_V2_SEED = Buffer.from("collateral");
export const collateralConfigV2Pda = (mint: PublicKey) => pda([COLLATERAL_CONFIG_V2_SEED, mint.toBuffer()]);
/** One sale listing per loan (Story 26.8). */
export const LISTING_V2_SEED = Buffer.from("listing");
export const listingV2Pda = (offer: PublicKey) => pda([LISTING_V2_SEED, offer.toBuffer()]);

/** Byte offsets after the 8-byte discriminator and 1-byte version, for memcmp filters. */
export const OFFER_V2_OFFSETS = { originLender: 9, currentLender: 41, borrower: 73 } as const;
export const REQUEST_V2_OFFSETS = { borrower: 9 } as const;
