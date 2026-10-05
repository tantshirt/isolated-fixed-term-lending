import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const pw = await import(
  require.resolve(process.env.PLAYWRIGHT_MODULE || "playwright")
);
const { chromium } = pw.default || pw;
const { PublicKey } = require("@solana/web3.js");
const base = process.env.BROWSER_BASE_URL || "http://localhost:3004";
const names = ["Phantom", "Backpack", "Jupiter", "MetaMask"];
const accounts = names.map((_, i) => ({
  address: new PublicKey(new Uint8Array(32).fill(i + 1)).toBase58(),
  publicKey: Array(32).fill(i + 1),
}));
const browser = await chromium.launch({ headless: true });
const errors = [];
async function setup(context) {
  await context.route("**/api/config", (r) =>
    r.fulfill({
      json: {
        config: {
          usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          wsolMint: "So11111111111111111111111111111111111111112",
          priceUpdateAccount: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
        },
        readiness: { ready: true, errors: [] },
        localControls: false,
      },
    })
  );
  await context.route("**/api/price*", (r) =>
    r.fulfill({
      json: {
        price: "15000000000",
        conf: "15000000",
        exponent: -8,
        publishTime: Math.floor(Date.now() / 1000),
        chainTime: Math.floor(Date.now() / 1000),
        fresh: true,
      },
    })
  );
  await context.route("https://api.devnet.solana.com/**", (r) => {
    const request = r.request().postDataJSON();
    const method = request.method;
    const result =
      method === "getProgramAccounts"
        ? []
        : method === "getSlot"
        ? 100
        : method === "getBlockTime"
        ? Math.floor(Date.now() / 1000)
        : method === "getBalance"
        ? { context: { slot: 100 }, value: 1000000000 }
        : { context: { slot: 100 }, value: null };
    return r.fulfill({ json: { jsonrpc: "2.0", id: request.id, result } });
  });
}
async function pageFor(context) {
  const p = await context.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  return p;
}
async function openPicker(p) {
  await p.getByRole("button", { name: "Connect", exact: true }).click();
  await p.getByRole("dialog", { name: "Choose your wallet" }).waitFor();
}
async function images(p) {
  await p.locator("dialog img").evaluateAll(async (imgs) => {
    await Promise.all(imgs.map((i) => i.decode()));
  });
  assert.equal(
    await p
      .locator("dialog img")
      .evaluateAll((imgs) =>
        imgs.every((i) => i.complete && i.naturalWidth > 0)
      ),
    true
  );
}
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await setup(context);
  const page = await pageFor(context);
  await page.goto(base + "/devnet");
  await page.getByRole("link", { name: /Get test SOL/ }).waitFor();
  await page.screenshot({
    path: "/private/tmp/lendspan-polish-devnet.png",
    fullPage: true,
  });
  await openPicker(page);
  for (const n of names)
    await page
      .getByRole("link", {
        name: `Get ${n} wallet (opens a new tab)`,
        exact: true,
      })
      .waitFor();
  await images(page);
  await page.screenshot({
    path: "/private/tmp/lendspan-polish-wallets.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByRole("button", { name: "Connect", exact: true })
      .evaluate((e) => e === document.activeElement),
    true
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await openPicker(page);
  await images(page);
  await page.screenshot({
    path: "/private/tmp/lendspan-polish-wallets-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page
      .locator("dialog")
      .evaluate((d) => d.getBoundingClientRect().right <= innerWidth)
  );
  await page.keyboard.press("Escape");
  await page.goto(base + "/devnet/create");
  await page
    .getByRole("textbox", { name: "You lend", exact: true })
    .fill("18446744073709.551615");
  assert.equal(
    await page.getByRole("textbox", { name: "You lend", exact: true }).inputValue(),
    "18,446,744,073,709.551615"
  );
  await page.screenshot({
    path: "/private/tmp/lendspan-polish-create-mobile.png",
    fullPage: true,
  });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Large amounts must not widen the mobile wizard");
  const mock = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await setup(mock);
  await mock.addInitScript(
    ({ names, accounts }) => {
      window.walletFixture = { calls: {}, reject: true };
      const wallets = names.map((name, index) => {
        let current = [];
        const listeners = new Set();
        const account = {
          ...accounts[index],
          publicKey: new Uint8Array(accounts[index].publicKey),
          chains: ["solana:devnet"],
          features: ["solana:signTransaction"],
        };
        return {
          version: "1.0.0",
          name,
          icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PC9zdmc+",
          chains: ["solana:devnet"],
          get accounts() {
            return current;
          },
          features: {
            "standard:events": {
              version: "1.0.0",
              on: (_event, listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
              },
            },
            "standard:connect": {
              version: "1.0.0",
              connect: async () => {
                window.walletFixture.calls[name] =
                  (window.walletFixture.calls[name] || 0) + 1;
                if (name === "Phantom" && window.walletFixture.reject) {
                  window.walletFixture.reject = false;
                  throw new Error("User rejected");
                }
                current = [account];
                listeners.forEach((l) => l({ accounts: current }));
                return { accounts: current };
              },
            },
            "standard:disconnect": {
              version: "1.0.0",
              disconnect: async () => {
                current = [];
                listeners.forEach((l) => l({ accounts: current }));
              },
            },
            "solana:signTransaction": {
              version: "1.0.0",
              supportedTransactionVersions: ["legacy", 0],
              signTransaction: async () => {
                throw new Error(
                  "Browser polish tests must never sign transactions"
                );
              },
            },
          },
        };
      });
      const register = (api) => api.register(...wallets);
      window.addEventListener("wallet-standard:app-ready", (e) =>
        register(e.detail)
      );
      window.dispatchEvent(
        new CustomEvent("wallet-standard:register-wallet", { detail: register })
      );
    },
    { names, accounts }
  );
  const mp = await pageFor(mock);
  await mp.goto(base + "/devnet");
  await openPicker(mp);
  await images(mp);
  await mp.getByRole("button", { name: /Phantom.*Connect/ }).click();
  await mp
    .getByRole("alert")
    .filter({ hasText: /connection was not approved/ })
    .waitFor();
  assert.equal(
    await mp.evaluate(() => window.walletFixture.calls.Phantom),
    1,
    "rejection must not automatically prompt again"
  );
  await mp.getByRole("button", { name: /Phantom.*Connect/ }).click();
  await mp
    .getByRole("dialog", { name: "Choose your wallet" })
    .waitFor({ state: "hidden" });
  for (const n of names.slice(1)) {
    await mp
      .getByRole("button", { name: /Phantom|Backpack|Jupiter|MetaMask/ })
      .first()
      .click();
    await mp
      .getByRole("button", { name: "Switch wallet", exact: true })
      .click();
    await mp.getByRole("button", { name: new RegExp(n + ".*Connect") }).click();
    await mp
      .getByRole("dialog", { name: "Choose your wallet" })
      .waitFor({ state: "hidden" });
  }
  assert.deepEqual(await mp.evaluate(() => window.walletFixture.calls), {
    Phantom: 2,
    Backpack: 1,
    Jupiter: 1,
    MetaMask: 1,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: official images, install links, mobile picker, focus restoration, exact inputs, Wallet Standard connect/switch, rejection without repeat prompt. No transactions signed."
  );
} finally {
  await browser.close();
}
