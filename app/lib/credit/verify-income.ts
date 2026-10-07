/**
 * Server-only core of POST /api/credit/verify (Story 26.7).
 *
 * Verifies a Reclaim income proof with the official SDK, checks it is bound to the requesting
 * wallet, maps the income to a band and tier, and drops the proof and the figure before returning.
 * The result carries only band, tier and what the issuer needs to write the SAS attestation.
 *
 * Hygiene: nothing here persists, logs, or forwards the proof or the income. No Convex, no
 * telemetry, no console. Errors are fixed strings that never echo input.
 */
import { PublicKey, Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { bandFor, CREDENTIAL_LIFETIME_SECONDS, parseIncome, tierFor, type CreditTier, type IncomeBand } from "./bands";
import { attestationPda, encodeCreditData, issuanceMessage } from "./sas";

/** The subset of `verifyProof` from `@reclaimprotocol/js-sdk` this route uses. */
export type VerifyProofFn = (
  proof: never,
  config: { providerId: string; providerVersion?: string },
) => Promise<{ isVerified: boolean; data: { context: Record<string, unknown>; extractedParameters: Record<string, string> }[] }>;

export type CreditEnv = {
  providerId?: string;
  providerVersion?: string;
  incomeParam?: string;
  issuerSecret?: string;
  credential?: string;
  schema?: string;
};

export function creditEnv(env: NodeJS.ProcessEnv = process.env): CreditEnv {
  return {
    providerId: env.RECLAIM_PROVIDER_ID,
    providerVersion: env.RECLAIM_PROVIDER_VERSION || undefined,
    incomeParam: env.RECLAIM_INCOME_PARAM,
    issuerSecret: env.CREDIT_ISSUER_SECRET,
    credential: env.NEXT_PUBLIC_SAS_CREDENTIAL,
    schema: env.NEXT_PUBLIC_SAS_SCHEMA,
  };
}

export type IssuanceRequest = {
  subject: string;
  tier: CreditTier;
  band: Exclude<IncomeBand, "below">;
  expiry: number;
  attestation: string;
  credential: string;
  schema: string;
  /** Hex of the 9-byte schema data: [tier u8][expiry i64 LE]. */
  data: string;
  issuer: string;
  /** Base64 Ed25519 signature by the issuer over `issuanceMessage`. */
  signature: string;
};

export type CreditOutcome =
  | { status: 200; body: { eligible: true; issuance: IssuanceRequest } }
  | { status: 200; body: { eligible: false; band: "below" } }
  | { status: 400 | 422 | 503; body: { error: string } };

const fail = (status: 400 | 422 | 503, error: string): CreditOutcome => ({ status, body: { error } });

function issuer(secret: string | undefined): Keypair | null {
  if (!secret) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  } catch {
    return null;
  }
}

/**
 * `input` is the parsed request body. The proof is read once, inside this call; the function holds
 * no reference to it afterwards and returns nothing derived from it except band and tier.
 */
export async function verifyIncome(input: unknown, verify: VerifyProofFn, env: CreditEnv, now: number): Promise<CreditOutcome> {
  const kp = issuer(env.issuerSecret);
  if (!env.providerId || !env.incomeParam || !env.credential || !env.schema || !kp) return fail(503, "Income verification is not configured on this deployment.");
  if (!input || typeof input !== "object") return fail(400, "Send a wallet and a proof.");
  const { wallet, proof } = input as { wallet?: unknown; proof?: unknown };
  let subject: PublicKey;
  try {
    subject = new PublicKey(typeof wallet === "string" ? wallet : "");
  } catch {
    return fail(400, "That wallet address is not valid.");
  }
  if (!proof || typeof proof !== "object") return fail(400, "Send a wallet and a proof.");

  let tier: CreditTier | null;
  let band: IncomeBand;
  {
    let result: Awaited<ReturnType<VerifyProofFn>>;
    try {
      result = await verify(proof as never, { providerId: env.providerId, ...(env.providerVersion ? { providerVersion: env.providerVersion } : {}) });
    } catch {
      return fail(422, "The proof could not be verified.");
    }
    if (!result.isVerified || result.data.length !== 1) return fail(422, "The proof could not be verified.");
    const [claim] = result.data;
    // Reclaim's context address must be this wallet, so a proof cannot be replayed for another one.
    if (String(claim.context?.contextAddress ?? "") !== subject.toBase58()) return fail(422, "The proof was made for another wallet.");
    const income = parseIncome(claim.extractedParameters?.[env.incomeParam]);
    if (income === null) return fail(422, "The proof does not contain a readable income.");
    band = bandFor(income);
    tier = tierFor(band);
    // `income`, `claim` and `result` go out of scope here; only band and tier survive.
  }
  if (tier === null || band === "below") return { status: 200, body: { eligible: false, band: "below" } };

  const expiry = now + CREDENTIAL_LIFETIME_SECONDS;
  const credential = new PublicKey(env.credential);
  const schema = new PublicKey(env.schema);
  const attestation = attestationPda(credential, schema, subject).toBase58();
  const fields = { subject: subject.toBase58(), credential: credential.toBase58(), schema: schema.toBase58(), attestation, tier, expiry };
  const signature = Buffer.from(nacl.sign.detached(issuanceMessage(fields), kp.secretKey)).toString("base64");
  return {
    status: 200,
    body: {
      eligible: true,
      issuance: { ...fields, band, data: encodeCreditData(tier, expiry).toString("hex"), issuer: kp.publicKey.toBase58(), signature },
    },
  };
}
