// End-to-end wallet sign-in against a running Convex deployment (local or hosted).
// Usage: node scripts/auth-e2e.mjs   (reads NEXT_PUBLIC_CONVEX_URL / _SITE_URL from .env.local)
// The deployment's AUTH_ALLOWED_DOMAINS must include ORIGIN_HOST (default localhost:3000).
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import nacl from "tweetnacl";
import { base58 } from "@scure/base";
import assert from "node:assert/strict";

const env = Object.fromEntries(readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
const site = env.NEXT_PUBLIC_CONVEX_SITE_URL;
const origin = `http://${process.env.ORIGIN_HOST ?? "localhost:3000"}`;
const kp = nacl.sign.keyPair();
const wallet = base58.encode(kp.publicKey);
const post = (path, body, headers = {}) =>
  fetch(site + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: JSON.stringify(body) });

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); assert.ok(cond, name); };

const c = await (await post("/auth/challenge", { wallet })).json();
check("challenge names the origin domain", c.message.startsWith("localhost:3000 wants you to sign in"));
const signature = base58.encode(nacl.sign.detached(new TextEncoder().encode(c.message), kp.secretKey));

const evil = await post("/auth/challenge", { wallet }, { Origin: "https://evil.example" });
check("disallowed origin gets 403", evil.status === 403);

const forged = await post("/auth/verify", { wallet, nonce: c.nonce, signature: base58.encode(nacl.sign.detached(new TextEncoder().encode("other"), kp.secretKey)) });
check("forged signature gets 401", forged.status === 401);

// A rejected signature does not burn the nonce, so the owner can still finish signing in.
const good = await post("/auth/verify", { wallet, nonce: c.nonce, signature });
check("valid signature issues a token", good.status === 200);
const { token } = await good.json();

const replay = await post("/auth/verify", { wallet, nonce: c.nonce, signature });
check("replayed nonce is rejected", replay.status === 401);

const client = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL);
client.setAuth(token);
const me = await client.query("auth:whoami", {});
check("Convex sees the signed-in wallet", me?.wallet === wallet);

const refreshed = await post("/auth/refresh", {}, { Authorization: `Bearer ${token}` });
check("refresh issues a new token", refreshed.status === 200);

await post("/auth/signout", {}, { Authorization: `Bearer ${token}` });
check("whoami is null after sign-out", (await client.query("auth:whoami", {})) === null);
const afterOut = await post("/auth/refresh", {}, { Authorization: `Bearer ${token}` });
check("refresh fails after sign-out", afterOut.status === 401);

console.log(JSON.stringify({ site, checks: results }, null, 2));
