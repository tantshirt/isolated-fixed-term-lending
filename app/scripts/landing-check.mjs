import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BROWSER_BASE_URL || 'http://localhost:3004';
const browser = await chromium.launch({headless:true});
try {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({viewport:{width:1440,height:1000}, reducedMotion});
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);
    await page.locator('main').waitFor();
    for (let i=0;i<3;i++) {
      await page.locator(`#loan-chapter-${i}`).scrollIntoViewIfNeeded();
      await page.waitForFunction(i=>document.querySelector(`a[href="#loan-chapter-${i}"]`)?.getAttribute('aria-current')==='step',i);
    }
    await page.locator('h1').scrollIntoViewIfNeeded();
    for (const img of await page.locator('main img').all()) {
      await img.scrollIntoViewIfNeeded();
      await img.evaluate(el=>el.decode());
    }
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:`/private/tmp/lendspan-story-${reducedMotion}.png`,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`/private/tmp/lendspan-story-mobile-${reducedMotion}.png`,fullPage:true});
    assert.deepEqual(errors,[]);
    await context.close();
  }
  const context=await browser.newContext();
  const page=await context.newPage();
  let configs=0, prices=0, rpc=0;
  await page.route('**/api/config', r=>{configs++;return r.fulfill({json:{config:{usdcMint:'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',wsolMint:'So11111111111111111111111111111111111111112',priceUpdateAccount:'7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE'},readiness:{ready:true,errors:[]},localControls:false}})});
  await page.route('**/api/price?*',r=>{prices++;return r.fulfill({status:503,json:{error:'Devnet is busy. Live price checks will resume shortly.'}})});
  await page.route(/https:\/\/api\.devnet\.solana\.com/,r=>{rpc++;return r.fulfill({status:429,headers:{'Retry-After':'30'},body:'Rate limited'})});
  await page.goto(base+'/devnet');
  await page.locator('summary').filter({hasText:'Prepare your wallet'}).waitFor();
  await page.waitForTimeout(1500);
  assert.equal(configs,1,'All configuration consumers must share one request');
  const initial=rpc;
  await page.waitForTimeout(11000);
  assert.equal(rpc,initial,'A 429 must stop SDK retries and subsequent polling during cooldown');
  assert.ok(prices<=1,'Price requests must back off after 503');
  console.log(`PASS: story progress, images, motion/reduced motion, mobile; config requests=${configs}, RPC requests during cooldown=${rpc}, price requests=${prices}.`);
} finally { await browser.close(); }
