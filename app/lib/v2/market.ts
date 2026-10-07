/**
 * Secondary market (Story 26.8, research.md § Secondary market). Every V2 position is sellable:
 * the current lender lists it at a USDC price, and a buyer takes it atomically and becomes
 * `current_lender`. The borrower's terms never change; only who is paid moves. This file mirrors
 * the program's rules so the interface never offers a step the program would refuse.
 */
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type Keypair } from "@solana/web3.js";
import type { BN } from "@coral-xyz/anchor";
import { phase } from "../loan-math-v2";
import { asSigner, type LoanSigner } from "../keypair-wallet";
import { bnU64, getConnection } from "../program";
import { submitTransaction } from "../transaction-lifecycle";
import type { OfferV2 } from "./offers";
import { PROGRAM_V2_ID, getProgramV2, listingV2Pda, v2Coder } from "./program";

/** Off until the deployment's programs carry the market instructions (Squads upgrade and time lock). */
export const SECONDARY_MARKET_ENABLED = process.env.NEXT_PUBLIC_SECONDARY_MARKET_ENABLED === "1";

/** The line every borrower review shows before signing. */
export const RESALE_NOTICE = "This position may be sold. Payments then go to the new holder.";

export type Listing = {
  publicKey: string;
  offer: string;
  seller: string;
  /** USDC atoms the buyer pays the seller. */
  price: bigint;
  /** Unix seconds; buyable while `now < expiry`. */
  expiry: number;
};

export type ListingState = "buyable" | "stale" | "expired" | "settled";

/**
 * The program's view of a listing: void once the loan settles (or is closed, `offer === null`) or
 * leaves its Active and Grace phases, once the seller is no longer the current lender, or at expiry.
 */
export function listingState(l: Pick<Listing, "seller" | "expiry">, offer: OfferV2 | null, now: number): ListingState {
  if (!offer || offer.status !== "active") return "settled";
  if (offer.currentLender !== l.seller) return "stale";
  if (now >= l.expiry) return "expired";
  const p = phase(offer.terms, now);
  if (p !== "Active" && p !== "Grace") return "settled";
  return "buyable";
}

/** Only the current lender may list, while the loan is Active and before grace ends. */
export function canList(offer: OfferV2, wallet: string | null, now: number): boolean {
  if (!wallet || offer.status !== "active" || offer.currentLender !== wallet) return false;
  const p = phase(offer.terms, now);
  return p === "Active" || p === "Grace";
}

/** Why `wallet` cannot buy this listing, or null when it can. */
export function buyBlocker(l: Listing, offer: OfferV2 | null, wallet: string, now: number): string | null {
  const s = listingState(l, offer, now);
  if (s === "settled") return "This loan has settled, so the listing is void.";
  if (s === "stale") return "The seller no longer holds this position.";
  if (s === "expired") return "This listing has expired.";
  if (wallet === offer!.borrower) return "The borrower cannot buy their own loan.";
  if (wallet === l.seller) return "You are the seller.";
  return null;
}

type RawListing = { offer: PublicKey; seller: PublicKey; price: BN; expiry: BN };

export function decodeListing(publicKey: PublicKey, data: Buffer): Listing {
  const a = v2Coder.decode("listing", data) as RawListing;
  return { publicKey: publicKey.toBase58(), offer: a.offer.toBase58(), seller: a.seller.toBase58(), price: BigInt(a.price.toString()), expiry: Number(a.expiry.toString()) };
}

export async function fetchListing(connection: Connection, offer: PublicKey): Promise<Listing | null> {
  const key = listingV2Pda(offer);
  const info = await connection.getAccountInfo(key);
  return info && info.owner.equals(PROGRAM_V2_ID) ? decodeListing(key, info.data as Buffer) : null;
}

export async function fetchListings(connection: Connection): Promise<Listing[]> {
  const rows = await connection.getProgramAccounts(PROGRAM_V2_ID, { filters: [{ memcmp: v2Coder.memcmp("listing") }] });
  return rows.map((r) => decodeListing(r.pubkey, r.account.data as Buffer));
}

type AnySigner = Keypair | LoanSigner;
const ata = (mint: PublicKey | string, owner: PublicKey | string) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true);

/** Current lender: lists (or re-lists, updating price and expiry) the position. */
export async function sendListPositionV2(signerLike: AnySigner, o: OfferV2, price: bigint, expiry: number, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const offer = new PublicKey(o.publicKey);
  const tx = await getProgramV2(signer, connection)
    .methods.listPosition(bnU64(price), bnU64(BigInt(expiry)))
    .accountsPartial({ seller: signer.publicKey, offer, listing: listingV2Pda(offer), systemProgram: SystemProgram.programId })
    .transaction();
  return submitTransaction(connection, signer, tx);
}

/** Seller: closes the listing and reclaims its rent. */
export async function sendCancelListingV2(signerLike: AnySigner, l: Listing, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const tx = await getProgramV2(signer, connection)
    .methods.cancelListing()
    .accountsPartial({ seller: signer.publicKey, listing: new PublicKey(l.publicKey) })
    .transaction();
  return submitTransaction(connection, signer, tx);
}

/** Buyer: pays exactly the listed price and becomes the current lender, in one instruction. */
export async function sendBuyPositionV2(signerLike: AnySigner, o: OfferV2, l: Listing, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const buyer = signer.publicKey;
  const offer = new PublicKey(o.publicKey);
  const seller = new PublicKey(l.seller);
  const tx = await getProgramV2(signer, connection)
    .methods.buyPosition(bnU64(l.price))
    .accountsPartial({
      buyer, offer, listing: new PublicKey(l.publicKey), seller, sellerUsdc: ata(o.usdcMint, seller), buyerUsdc: ata(o.usdcMint, buyer), tokenProgram: TOKEN_PROGRAM_ID,
    })
    // A seller who closed their USDC account cannot block the sale; later payments need the buyer's.
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(buyer, ata(o.usdcMint, seller), seller, new PublicKey(o.usdcMint)),
      createAssociatedTokenAccountIdempotentInstruction(buyer, ata(o.usdcMint, buyer), buyer, new PublicKey(o.usdcMint)),
    ])
    .transaction();
  return submitTransaction(connection, signer, tx);
}

/** Anyone: closes a void listing; the rent returns to the seller. */
export async function sendCloseListingV2(signerLike: AnySigner, l: Listing, connection = getConnection()): Promise<string> {
  const signer = asSigner(signerLike);
  const tx = await getProgramV2(signer, connection)
    .methods.closeListing()
    .accountsPartial({ listing: new PublicKey(l.publicKey), offer: new PublicKey(l.offer), seller: new PublicKey(l.seller) })
    .transaction();
  return submitTransaction(connection, signer, tx);
}
