import type { IssuanceRequest } from "./verify-income";

/** Whitelist the signed public credential fields; never serialize the verification response. */
export function issuanceHandoff(i: IssuanceRequest): string {
  return JSON.stringify({ subject: i.subject, tier: i.tier, expiry: i.expiry, attestation: i.attestation, credential: i.credential, schema: i.schema, data: i.data, issuer: i.issuer, signature: i.signature }, null, 2);
}
