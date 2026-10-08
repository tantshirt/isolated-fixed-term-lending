/**
 * Story 27.1: the private credit tier computed by Arcium (`zenlo_credit_mxe`). Pure and
 * server-safe. Reads the borrower's `TierResult` at `["arcium-tier", borrower]` by hand, with the
 * same validity rule `isolated_loan_v2` applies (`credit_tier::read_tier_result`).
 *
 * The tier is computed from the borrower's rollup-signed `HistoryAttestation` (counts published by
 * `private_loan_v2`, never typed in) and the band of their SAS credential; only the tier is
 * revealed. Nothing here stores or sends anything.
 */
import { PublicKey, type Connection } from "@solana/web3.js";

export const CREDIT_MXE_ID = new PublicKey("828JKMx1RDffwUtWAKQ7gwyFwWEBrxoWQ5UnnJ9Upreb");
export const TIER_RESULT_SEED = Buffer.from("arcium-tier");
export const TIER_RESULT_LEN = 148;
/** An attestation (and a tier computed from it) is stale after 30 days. */
export const MAX_ATTESTATION_AGE_SECONDS = 30 * 86_400;
export const MAX_FUTURE_SKEW_SECONDS = 300;

/** Story 27.1 flag ("1" or "true"). Off until zenlo_credit_mxe is deployed on cluster 456. */
export const arciumEnabled = (v: string | undefined = process.env.NEXT_PUBLIC_ARCIUM_ENABLED) => v === "1" || v === "true";
export const ARCIUM_ENABLED = arciumEnabled();

/** `sha256("account:TierResult")[..8]` (checked in arcium.test.ts). */
export const TIER_RESULT_DISCRIMINATOR = Buffer.from([184, 145, 6, 108, 238, 82, 35, 33]);

export const tierResultPda = (borrower: PublicKey) => PublicKey.findProgramAddressSync([TIER_RESULT_SEED, borrower.toBuffer()], CREDIT_MXE_ID)[0];

export type TierResult = {
  borrower: string;
  tier: number;
  computedAt: number;
  attestedAt: number;
  incomeValidUntil: number;
  pending: boolean;
};

export type ArciumTierStatus =
  | { state: "none" }
  | { state: "pending"; last: TierResult }
  | { state: "valid"; tier: 1 | 2 | 3; validUntil: number; result: TierResult }
  | { state: "unusable"; reason: string; result: TierResult };

const i64 = (b: Buffer, at: number) => Number(b.readBigInt64LE(at));

/** Decodes a TierResult account, or null if the bytes are not one. Offsets: credit_tier::tier_offsets. */
export function decodeTierResult(data: Buffer): TierResult | null {
  if (data.length < TIER_RESULT_LEN || !data.subarray(0, 8).equals(TIER_RESULT_DISCRIMINATOR) || data[8] !== 1) return null;
  return {
    borrower: new PublicKey(data.subarray(9, 41)).toBase58(),
    tier: data[41],
    computedAt: i64(data, 50),
    attestedAt: i64(data, 66),
    incomeValidUntil: i64(data, 74),
    pending: data[82] === 1,
  };
}

/** The status the loan program would see at `now` for `borrower`. */
export function tierStatus(r: TierResult | null, borrower: string, now: number): ArciumTierStatus {
  if (!r) return { state: "none" };
  if (r.computedAt <= 0) return r.pending ? { state: "pending", last: r } : { state: "none" };
  if (r.borrower !== borrower) return { state: "unusable", reason: "This result belongs to another wallet.", result: r };
  const fresh = r.attestedAt > 0 && r.attestedAt <= now + MAX_FUTURE_SKEW_SECONDS && now - r.attestedAt <= MAX_ATTESTATION_AGE_SECONDS;
  if (!fresh) return { state: "unusable", reason: "It was computed from a history attestation older than 30 days. Attest again and request a new tier.", result: r };
  if (r.incomeValidUntil <= now) return { state: "unusable", reason: "The income credential it used has expired.", result: r };
  if (r.tier < 1 || r.tier > 3) return { state: "unusable", reason: "Your history and income band do not reach tier 1 yet.", result: r };
  return { state: "valid", tier: r.tier as 1 | 2 | 3, validUntil: Math.min(r.attestedAt + MAX_ATTESTATION_AGE_SECONDS, r.incomeValidUntil), result: r };
}

export async function fetchArciumTier(connection: Connection, borrower: PublicKey, now: number): Promise<ArciumTierStatus> {
  const info = await connection.getAccountInfo(tierResultPda(borrower), "confirmed");
  if (!info || !info.owner.equals(CREDIT_MXE_ID)) return { state: "none" };
  return tierStatus(decodeTierResult(Buffer.from(info.data)), borrower.toBase58(), now);
}
