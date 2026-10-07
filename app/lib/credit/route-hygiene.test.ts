import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { verifyIncome, type CreditEnv, type VerifyProofFn } from "./verify-income";
import { issuanceMessage } from "./sas";

const ROUTE = join(__dirname, "..", "..", "app", "api", "credit", "verify", "route.ts");
const SESSION = join(__dirname, "..", "..", "app", "api", "credit", "session", "route.ts");
const CORE = join(__dirname, "verify-income.ts");

const issuer = Keypair.generate();
const env: CreditEnv = {
  providerId: "provider-1",
  incomeParam: "monthlyIncome",
  issuerSecret: JSON.stringify(Array.from(issuer.secretKey)),
  credential: Keypair.generate().publicKey.toBase58(),
  schema: Keypair.generate().publicKey.toBase58(),
};
const wallet = Keypair.generate().publicKey.toBase58();
// A distinctive income so any leak of it is easy to find.
const INCOME = "7,345.67";
const proof = { identifier: "0xproof", claimData: { context: "{}", parameters: "{}" }, signatures: ["0xsig"], witnesses: [], extractedParameterValues: { monthlyIncome: INCOME } };

const mockVerify = (contextAddress: string, income = INCOME, ok = true): VerifyProofFn =>
  (async () => ({ isVerified: ok, data: ok ? [{ context: { contextAddress }, extractedParameters: { monthlyIncome: income } }] : [] })) as VerifyProofFn;

/** Runs `fn` with every console method captured. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const saved = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    methods.forEach((m, i) => (console[m] = saved[i]));
  }
}

test("an eligible proof returns tier and a signed issuance request, never the income", async () => {
  const { result, lines } = await captureConsole(() => verifyIncome({ wallet, proof }, mockVerify(wallet), env, 1_800_000_000));
  assert.equal(result.status, 200);
  const body = result.body as { eligible: true; issuance: { tier: number; band: string; signature: string; subject: string; credential: string; schema: string; attestation: string; expiry: number; data: string } };
  assert.equal(body.eligible, true);
  assert.equal(body.issuance.tier, 2);
  assert.equal(body.issuance.band, "middle");
  assert.equal(body.issuance.expiry, 1_800_000_000 + 180 * 86_400);
  assert.equal(body.issuance.data.length, 18);
  const json = JSON.stringify(result.body);
  for (const leak of ["7345", "7,345", "monthlyIncome", "0xproof", "0xsig", "extractedParameters", "claimData"]) assert.ok(!json.includes(leak), `response leaks ${leak}`);
  assert.deepEqual(lines, [], "nothing is logged");
  const i = body.issuance;
  const msg = issuanceMessage({ subject: i.subject, credential: i.credential, schema: i.schema, attestation: i.attestation, tier: 2, expiry: i.expiry });
  assert.ok(nacl.sign.detached.verify(msg, Buffer.from(i.signature, "base64"), issuer.publicKey.toBytes()));
});

test("a low income is ineligible and still returns no figure", async () => {
  const { result, lines } = await captureConsole(() => verifyIncome({ wallet, proof }, mockVerify(wallet, "1,234"), env, 0));
  assert.deepEqual(result.body, { eligible: false, band: "below" });
  assert.deepEqual(lines, []);
});

test("unverified, foreign-wallet, unreadable and unconfigured requests fail closed without echoing input", async () => {
  const other = Keypair.generate().publicKey.toBase58();
  const cases = await Promise.all([
    verifyIncome({ wallet, proof }, mockVerify(wallet, INCOME, false), env, 0),
    verifyIncome({ wallet, proof }, mockVerify(other), env, 0),
    verifyIncome({ wallet, proof }, mockVerify(wallet, "lots"), env, 0),
    verifyIncome({ wallet, proof }, mockVerify(wallet), { ...env, issuerSecret: undefined }, 0),
    verifyIncome({ wallet: "nope", proof }, mockVerify(wallet), env, 0),
    verifyIncome({ wallet }, mockVerify(wallet), env, 0),
    verifyIncome({ wallet, proof }, (async () => { throw new Error(`bad proof ${INCOME}`); }) as VerifyProofFn, env, 0),
  ]);
  assert.deepEqual(cases.map((c) => c.status), [422, 422, 422, 503, 400, 400, 422]);
  for (const c of cases) assert.ok(!JSON.stringify(c.body).includes("7,345") && !JSON.stringify(c.body).includes("lots"));
});

test("the route and its core never touch Convex, logs, storage or other networks", () => {
  for (const file of [ROUTE, SESSION, CORE]) {
    const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /convex/i, `${file} imports Convex`);
    assert.doesNotMatch(src, /console\./, `${file} logs`);
    assert.doesNotMatch(src, /\bfetch\(|writeFile|appendFile|localStorage|posthog|sentry|track\(/i, `${file} sends or stores data`);
    assert.doesNotMatch(src, /NEXT_PUBLIC_CREDIT_ISSUER_SECRET|NEXT_PUBLIC_RECLAIM_APP_SECRET/, `${file} exposes a secret`);
  }
  const route = readFileSync(ROUTE, "utf8");
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /from "@reclaimprotocol\/js-sdk"/);
});

test("the route is hidden unless the pilot flag is on", async () => {
  const saved = process.env.NEXT_PUBLIC_CREDIT_PILOT_ENABLED;
  delete process.env.NEXT_PUBLIC_CREDIT_PILOT_ENABLED;
  try {
    const { POST } = await import("../../app/api/credit/verify/route");
    const res = await POST(new Request("http://x/api/credit/verify", { method: "POST", body: JSON.stringify({ wallet, proof }) }));
    assert.equal(res.status, 404);
  } finally {
    if (saved !== undefined) process.env.NEXT_PUBLIC_CREDIT_PILOT_ENABLED = saved;
  }
});
