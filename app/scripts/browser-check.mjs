/* Run against a built app: PLAYWRIGHT_MODULE=/path/to/playwright node scripts/browser-check.mjs */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const playwright = await import(
  require.resolve(process.env.PLAYWRIGHT_MODULE || "playwright")
);
const { chromium } = playwright.default || playwright;
import assert from "node:assert/strict";
const base = process.env.BROWSER_BASE_URL || "http://localhost:3003";
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  let page = await context.newPage();
  const errors = [];
  const chainRequests = [];
  page.on("request", (r) => {
    if (
      /\/api\/(config|price|setup|fund|warp|set-price)|api\.devnet|solana-devnet/.test(
        r.url()
      )
    )
      chainRequests.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  async function visit(path) {
    const r = await page.goto(base + path);
    assert.equal(r.status(), 200, path);
    await page.locator("main").waitFor();
  }
  async function status(value) {
    await page
      .getByTestId("loan-status")
      .filter({ hasText: new RegExp("^" + value + "$") })
      .waitFor();
  }
  async function create() {
    await page
      .getByRole("link", { name: "Set the terms →", exact: true })
      .click();
    for (let i = 1; i <= 3; i++) {
      await page.getByTestId("wizard-step-" + i).waitFor();
      await page
        .getByRole("button", { name: "Continue →", exact: true })
        .click();
    }
    await page.getByTestId("wizard-step-4").waitFor();
    await page
      .getByRole("button", { name: "Create simulated offer", exact: true })
      .click();
    await status("open");
  }
  async function reset() {
    await page.getByRole("button", { name: "Reset demo", exact: true }).click();
    await page
      .getByRole("link", { name: "Set the terms →", exact: true })
      .waitFor();
  }
  async function borrow() {
    await page
      .getByLabel("Acting as", { exact: true })
      .selectOption("borrower");
    await page
      .getByRole("button", { name: "Lock wSOL and borrow", exact: true })
      .click();
    await status("filled");
  }
  await visit("/");
  assert.match(await page.locator("body").innerText(), /LegitShark/);
  await page.screenshot({
    path: "/private/tmp/lendspan-landing.png",
    fullPage: true,
  });
  await visit("/demo");
  await create();
  await page
    .getByRole("button", { name: "Lock wSOL and borrow", exact: true })
    .click();
  assert.match(
    await page.locator("main [role=alert]").innerText(),
    /borrower/i
  );
  await borrow();
  await page.reload();
  await status("filled");
  await page
    .getByRole("button", { name: "Repay as borrower", exact: true })
    .click();
  await status("repaid");
  assert.match(await page.getByTestId("receipts").innerText(), /repay/i);
  await page.getByLabel("Acting as", { exact: true }).selectOption("lender");
  await page
    .getByRole("button", { name: "Close receipt as lender", exact: true })
    .click();
  await status("closed");
  await reset();
  await create();
  await borrow();
  await page.getByTestId("drop-price").click();
  await page
    .getByLabel("Acting as", { exact: true })
    .selectOption("liquidator");
  await page
    .getByRole("button", { name: "Liquidate as liquidator", exact: true })
    .click();
  await status("liquidated");
  await reset();
  await create();
  await borrow();
  await page.getByTestId("expire-loan").click();
  await page
    .getByRole("button", { name: "Repay as borrower", exact: true })
    .click();
  assert.match(await page.locator("main [role=alert]").innerText(), /deadline/);
  await page
    .getByRole("button", { name: "Claim expired collateral", exact: true })
    .click();
  await status("expired");
  await reset();
  await create();
  await page
    .getByRole("button", { name: "Cancel offer as lender", exact: true })
    .click();
  await status("cancelled");
  await reset();
  await page.reload();
  await page
    .getByRole("link", { name: "Set the terms →", exact: true })
    .waitFor();
  await page.evaluate(() => {
    localStorage.setItem("lendspan-simulation-v1", "{broken");
    location.reload();
  });
  await page
    .getByRole("status")
    .filter({ hasText: /saved simulation could not be read/ })
    .waitFor();
  await visit("/demo/create?step=4");
  await page.getByTestId("wizard-step-4").waitFor();
  assert.deepEqual(
    chainRequests,
    [],
    "landing and simulation must not call chain APIs"
  );
  await visit("/demo/create");
  await page.locator("#USDCamount").fill("0");
  await page.getByRole("button", { name: "Continue →", exact: true }).click();
  assert.equal(
    await page.locator("#USDCamount").getAttribute("aria-invalid"),
    "true"
  );
  await page.reload();
  await page.getByTestId("wizard-step-1").waitFor();
  await page.locator("#USDCamount").fill("100");
  await page.getByRole("button", { name: "Continue →", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("wizard-step-2").waitFor();
  assert.equal(
    await page.locator("h1").evaluate((e) => e === document.activeElement),
    true,
    "wizard focuses heading"
  );
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["/", "/demo", "/demo/create", "/devnet"]) {
      await visit(route);
      const dimensions = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert.ok(
        dimensions.scroll <= dimensions.width + 1,
        `${route} overflow at ${width}: ${dimensions.scroll}`
      );
      await page.screenshot({
        path: `/private/tmp/lendspan-${
          route.replaceAll("/", "-") || "home"
        }-${width}.png`,
        fullPage: true,
      });
    }
  }
  const blocked = await browser.newContext({ reducedMotion: "reduce" });
  await blocked.addInitScript(() => {
    for (const method of ["getItem", "setItem", "removeItem"])
      Storage.prototype[method] = () => {
        throw new DOMException("Storage blocked", "SecurityError");
      };
  });
  page = await blocked.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await visit("/demo");
  await create();
  await borrow();
  await page
    .getByRole("button", { name: "Repay as borrower", exact: true })
    .click();
  await status("repaid");
  assert.deepEqual(errors, [], "uncaught browser errors");
  console.log(
    "PASS: landing, all demo outcomes, authority/deadline errors, reload, corrupt storage, deep link, keyboard, blocked storage, responsive routes; no uncaught browser errors."
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
