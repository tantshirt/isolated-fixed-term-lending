/**
 * Per-asset collateral accounts for isolated_loan_v2 (Story 26.2).
 *
 * Canonical wSOL keeps the built-in SOL/USD constants and passes nothing extra. Any other
 * collateral mint passes its `CollateralConfig` PDA `["collateral", mint]` as the FIRST remaining
 * account of create_offer, create_request, accept_offer, fund_request, liquidate,
 * liquidate_overdue and claim_priced_recovery (architecture.md § Collateral resolution), and its
 * priced paths read the asset's own Pyth feed. For jitoSOL (test) that is JITOSOL/USD, posted
 * through the Pyth receiver right before the instruction that reads it, in one signed sequence.
 */
import { PublicKey, type AccountMeta, type Connection, type Signer, type Transaction } from "@solana/web3.js";
import { NATIVE_WSOL_MINT, PYTH_PRICE_SHARD, PYTH_PUSH_PROGRAM_ID, PYTH_RECEIVER_PROGRAM_ID } from "../constants";
import type { LoanSigner } from "../keypair-wallet";
import { collateralForMint, hasOwnFeed } from "../models/collateral";
import type { CollateralAsset } from "../models";
import { submitTransaction } from "../transaction-lifecycle";
import { PROGRAM_V2_ID } from "./program";

export const COLLATERAL_CONFIG_SEED = Buffer.from("collateral");

const key = (k: PublicKey | string) => (typeof k === "string" ? new PublicKey(k) : k);

/** `["collateral", mint]` under isolated_loan_v2. */
export function collateralConfigPda(mint: PublicKey | string, programId: PublicKey = PROGRAM_V2_ID): PublicKey {
  return PublicKey.findProgramAddressSync([COLLATERAL_CONFIG_SEED, key(mint).toBuffer()], programId)[0];
}

/** Whether this collateral mint needs a `CollateralConfig` and its own feed. */
export function needsCollateralConfig(mint: PublicKey | string): boolean {
  return !key(mint).equals(NATIVE_WSOL_MINT);
}

/**
 * Remaining accounts for an instruction that resolves collateral. Empty for canonical wSOL;
 * otherwise the `CollateralConfig` PDA first, read-only. Any further remaining account must come
 * after it.
 */
export function collateralRemainingAccounts(mint: PublicKey | string, programId: PublicKey = PROGRAM_V2_ID): AccountMeta[] {
  if (!needsCollateralConfig(mint)) return [];
  return [{ pubkey: collateralConfigPda(mint, programId), isSigner: false, isWritable: false }];
}

/** The Pyth push-feed account for a feed id (the same derivation as the SOL/USD shard account). */
export function feedPriceAccount(feedIdHex: string, shard = PYTH_PRICE_SHARD): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from([shard, 0]), Buffer.from(feedIdHex, "hex")], PYTH_PUSH_PROGRAM_ID)[0];
}

/** The price account a priced instruction reads: `fallback` (SOL/USD) for wSOL, else the asset's own feed. */
export function collateralPriceAccount(mint: PublicKey | string, fallback: PublicKey): PublicKey {
  const asset = collateralForMint(key(mint).toBase58());
  return hasOwnFeed(asset) && needsCollateralConfig(mint) ? feedPriceAccount(asset.feedIdHex) : fallback;
}

/** Which feed the relay serves; only allowlisted feeds leave the server. */
export type FeedKey = "sol" | "jitosol";
export const feedKeyFor = (asset: CollateralAsset): FeedKey => (hasOwnFeed(asset) ? "jitosol" : "sol");

/** Signed Hermes update bytes for one feed, through the app's read-only relay. */
export async function fetchFeedUpdate(feed: FeedKey): Promise<string[]> {
  const response = await fetch(`/api/pyth-update?feed=${feed}`, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Unable to fetch a Pyth update");
  return body.data as string[];
}

type Batch = { tx: Transaction; signers: Signer[] };

/**
 * Builds the signed sequence for a priced instruction on collateral with its own feed: the
 * Hermes update is verified and written to the asset's push-feed account through the Pyth
 * receiver, then `tx`'s instructions run, then the encoded VAA is closed. The receiver's builder
 * packs the consumer instructions into the same transaction as the price write when they fit.
 */
export async function pricedBatches(
  connection: Connection,
  signer: LoanSigner,
  tx: Transaction,
  updateData: string[],
): Promise<Batch[]> {
  const { PythSolanaReceiver } = await import("@pythnetwork/pyth-solana-receiver");
  const receiver = new PythSolanaReceiver({
    connection,
    wallet: signer as ConstructorParameters<typeof PythSolanaReceiver>[0]["wallet"],
    receiverProgramId: PYTH_RECEIVER_PROGRAM_ID,
    pushOracleProgramId: PYTH_PUSH_PROGRAM_ID,
  });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addUpdatePriceFeed(updateData, PYTH_PRICE_SHARD);
  await builder.addPriceConsumerInstructions(async () => tx.instructions.map((instruction) => ({ instruction, signers: [] })));
  return builder.buildLegacyTransactions({});
}

/**
 * Submits `tx` for a loan on `mint`. wSOL goes straight through; collateral with its own feed
 * first posts a fresh update of that feed, so no separate "post a price" step is needed.
 */
export async function submitCollateralTx(
  connection: Connection,
  signer: LoanSigner,
  mint: PublicKey | string,
  tx: Transaction,
  fetchUpdate: (feed: FeedKey) => Promise<string[]> = fetchFeedUpdate,
): Promise<string> {
  const asset = collateralForMint(key(mint).toBase58());
  if (!needsCollateralConfig(mint) || !hasOwnFeed(asset)) return submitTransaction(connection, signer, tx);
  const batches = await pricedBatches(connection, signer, tx, await fetchUpdate(feedKeyFor(asset)));
  let last = "";
  for (const b of batches) last = await submitTransaction(connection, signer, b.tx, b.signers);
  return last;
}
