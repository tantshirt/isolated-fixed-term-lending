import test from "node:test";
import assert from "node:assert/strict";
import { issuanceHandoff } from "./issuance-handoff";
import type { IssuanceRequest } from "./verify-income";

test("issuer handoff keeps the signed fields and strips proof, income and response extras", () => {
  const fields = { subject: "wallet", tier: 2 as const, expiry: 123, attestation: "attestation", credential: "credential", schema: "schema", data: "020000000000000000", issuer: "issuer", signature: "signed" };
  const response = { ...fields, band: "mid", proof: { secret: "proof" }, income: "5000" } as unknown as IssuanceRequest;
  assert.deepEqual(JSON.parse(issuanceHandoff(response)), fields);
});
