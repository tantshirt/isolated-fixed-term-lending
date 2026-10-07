#!/usr/bin/env node
// Connects ZenLo's providers from one local file (.env.providers), so each turns on the moment its
// key exists. Dry run by default; --apply makes the changes. Never prints secret values.
//
//  - Convex deployment env: auth key, ops wallets, Telegram and MoneyGram secrets.
//  - Vercel (production + preview): NEXT_PUBLIC_TELEGRAM_ENABLED / NEXT_PUBLIC_MONEYGRAM_ENABLED = 1
//    only when that provider's server keys are present.
//  - Telegram: registers the webhook at <convex site>/telegram/webhook with the secret token.
//  - MoneyGram: prints the webhook URL to paste into the partner portal (it has no API for this).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const apply = process.argv.includes("--apply");
const read = (f) =>
  existsSync(f)
    ? Object.fromEntries(
        readFileSync(f, "utf8")
          .split("\n")
          .filter((l) => /^[A-Z_]+=/.test(l))
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
      )
    : {};
const p = read(".env.providers");
const local = read(".env.local");
if (!existsSync(".env.providers")) {
  console.log("No .env.providers yet. Copy .env.providers.example, fill what you have, and run again.");
  process.exit(0);
}
const has = (k) => Boolean(p[k]);
const site = (local.NEXT_PUBLIC_CONVEX_SITE_URL || "").replace(/\/$/, "");
const target = p.CONVEX_DEPLOY_TARGET ? ["--deployment-name", p.CONVEX_DEPLOY_TARGET.replace(/^\w+:/, "")] : [];
const plan = [];

const convexKeys = ["AUTH_JWT_PRIVATE_JWK", "AUTH_ALLOWED_DOMAINS", "AUTH_NETWORK", "OPS_ADMIN_WALLETS", "OPS_REPORT_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET", "RAMPS_SECRET_KEY", "MONEYGRAM_ENV", "MONEYGRAM_WEBHOOK_HOST"];
for (const k of convexKeys) if (has(k)) plan.push({ what: `Convex env ${k}`, run: () => execFileSync("npx", ["convex", "env", "set", ...target, k, p[k]], { stdio: "ignore" }) });

const telegramReady = has("TELEGRAM_BOT_TOKEN") && has("TELEGRAM_BOT_USERNAME") && has("TELEGRAM_WEBHOOK_SECRET");
const moneygramReady = has("RAMPS_SECRET_KEY") && has("MONEYGRAM_WEBHOOK_HOST");
const vercelFlag = (name, value) => ({
  what: `Vercel ${name}=${value} (production, preview)`,
  run: () => {
    for (const env of ["production", "preview"]) {
      try {
        execFileSync("vercel", ["env", "rm", name, env, "--yes"], { stdio: "ignore" });
      } catch {}
      execFileSync("vercel", ["env", "add", name, env], { input: value, stdio: ["pipe", "ignore", "ignore"] });
    }
  },
});
plan.push(vercelFlag("NEXT_PUBLIC_PRIVATE_V2_LIVE", "1"));
if (telegramReady) plan.push(vercelFlag("NEXT_PUBLIC_TELEGRAM_ENABLED", "1"));
if (moneygramReady) plan.push(vercelFlag("NEXT_PUBLIC_MONEYGRAM_ENABLED", "1"), vercelFlag("NEXT_PUBLIC_MONEYGRAM_ENV", p.MONEYGRAM_ENV || "sandbox"));

if (telegramReady && site)
  plan.push({
    what: `Telegram webhook -> ${site}/telegram/webhook`,
    run: async () => {
      const r = await fetch(`https://api.telegram.org/bot${p.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${site}/telegram/webhook`, secret_token: p.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message"] }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(`Telegram refused the webhook: ${j.description}`);
    },
  });

const missing = [
  !has("AUTH_JWT_PRIVATE_JWK") && "wallet sign-in key (node scripts/auth-keygen.mjs)",
  !telegramReady && "Telegram bot token, username and webhook secret",
  !moneygramReady && "MoneyGram Ramps secret key and webhook host",
  !site && "NEXT_PUBLIC_CONVEX_SITE_URL in .env.local (hosted Convex)",
].filter(Boolean);

console.log(apply ? "Applying:" : "Dry run. Would apply:");
for (const step of plan) console.log(`  - ${step.what}`);
if (missing.length) console.log(`Still missing (those parts stay off):\n${missing.map((m) => `  - ${m}`).join("\n")}`);
if (moneygramReady && site) console.log(`\nPaste into MoneyGram's partner portal as the webhook URL: ${site}/moneygram/webhook`);
if (!apply) process.exit(0);
for (const step of plan) {
  await step.run();
  console.log(`done: ${step.what}`);
}
console.log("Redeploy on Vercel so the public switches take effect.");
