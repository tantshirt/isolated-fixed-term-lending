// Alerts end to end against a running Convex deployment (Story 24.3):
// sign in, consent to alerts on a public V2 loan, link Telegram through a one-use link and the
// secret-checked webhook, then run the scan. Without TELEGRAM_BOT_TOKEN the send job fails
// permanently with a clear reason, which proves everything up to Telegram's API.
// Usage: node scripts/alerts-e2e.mjs <public-v2-loan>   (needs TELEGRAM_WEBHOOK_SECRET in env)
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import nacl from "tweetnacl";
import { base58 } from "@scure/base";
import assert from "node:assert/strict";

const env = Object.fromEntries(readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const site = env.NEXT_PUBLIC_CONVEX_SITE_URL;
const loan = process.argv[2];
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
assert.ok(loan && secret, "usage: TELEGRAM_WEBHOOK_SECRET=... node scripts/alerts-e2e.mjs <loan>");

const kp = nacl.sign.keyPair();
const wallet = base58.encode(kp.publicKey);
const post = (path, body, headers = {}) => fetch(site + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...headers }, body: JSON.stringify(body) });
const c = await (await post("/auth/challenge", { wallet })).json();
const sig = base58.encode(nacl.sign.detached(new TextEncoder().encode(c.message), kp.secretKey));
const { token } = await (await post("/auth/verify", { wallet, nonce: c.nonce, signature: sig })).json();
const client = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL);
client.setAuth(token);

const checks = {};
const check = (name, ok) => { checks[name] = !!ok; assert.ok(ok, name); };

await client.mutation("alerts:subscribe", { kind: "public-v2", loan });
let mine = await client.query("alerts:myAlerts", {});
check("subscribed with consent", mine.subscriptions.length === 1 && !mine.telegramLinked);
let refused = false;
try { await client.mutation("alerts:subscribe", { kind: "private", loan }); } catch { refused = true; }
check("private alerts require shared deadlines", refused);

const { url } = await client.mutation("alerts:createTelegramLink", {});
const nonce = new URL(url).searchParams.get("start");
check("one-use link names the bot", url.startsWith("https://t.me/zenlo_test_bot?start="));
const hook = (n, s = secret) => post("/telegram/webhook", { message: { chat: { id: 4242 }, text: `/start ${n}` } }, { "X-Telegram-Bot-Api-Secret-Token": s });
check("webhook refuses a wrong secret", (await hook(nonce, "x".repeat(secret.length))).status === 401);
check("webhook accepts the real secret", (await hook(nonce)).status === 200);
mine = await client.query("alerts:myAlerts", {});
check("chat linked to the signed-in wallet", mine.telegramLinked);
await hook(nonce);
console.log(JSON.stringify({ wallet, checks }, null, 2));
