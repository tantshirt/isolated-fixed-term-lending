import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BROWSER_BASE_URL || 'http://localhost:3010';
const browser = await chromium.launch({headless:true});
const paths = ['/', '/use-cases', '/learn', '/devnet', '/devnet/discover', '/devnet/me', '/devnet/private', '/devnet/learn', '/devnet/private/liquidate', '/devnet/private/rooms/invalid'];
try {
  for (const width of [390, 820, 1440]) {
    const context = await browser.newContext({viewport:{width,height:1000}, reducedMotion:'reduce'});
    const page = await context.newPage();
    const errors=[];
    page.on('pageerror', e=>errors.push(e.message));
    for (const path of paths) {
      const response=await page.goto(base+path);
      assert.equal(response.status(),200,path);
      await page.locator('main').waitFor();
      await page.waitForTimeout(350);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), `overflow ${path} ${width}`);
      if (path==='/learn') {
        await page.getByRole('link',{name:'Start the simulation'}).waitFor();
        await page.getByRole('link',{name:'Practice with a Devnet wallet'}).waitFor();
      }
      if (path.startsWith('/devnet')) assert.equal(await page.getByRole('navigation',{name:'Main',exact:true}).getByRole('link',{name:'Create offer',exact:true}).count(),0);
      const images = await page.locator('main img[src*="illustrations"]').evaluateAll((els) => els.map((el) => { el.loading = "eager"; return { src: el.currentSrc || el.src, alt: el.alt }; }));
      for (const img of images) {
        await page.evaluate(({src}) => { const image = new Image(); image.src = src; return Promise.race([image.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error(`Image decode timed out: ${src}`)), 10000))]); }, img);
        assert.ok(!/zl-|pebble/i.test(img.src+' '+img.alt), 'Retired illustration remains');
      }
      await page.evaluate(() => scrollTo(0,0));
      await page.screenshot({path:`/private/tmp/zenlo-refinement-${width}-${path.replaceAll('/','_')||'home'}.png`,fullPage:true});
    }
    assert.deepEqual(errors,[]);
    await page.goto(base+'/devnet/private/lab');
    await page.waitForURL('**/devnet/learn');
    await context.close();
  }
  const context=await browser.newContext();
  const page=await context.newPage();
  let chain=0;
  page.on('request',r=>{if(/\/api\/(config|price)|api\.devnet|solana-devnet/.test(r.url()))chain++;});
  await page.goto(base+'/learn');
  await page.waitForTimeout(500);
  assert.equal(chain,0,'Learn must stay wallet-free and chain-independent');
  await page.goto(base);
  const pause=page.getByRole('button',{name:'Pause artwork',exact:true});
  await pause.click();
  assert.equal(await page.getByRole('button',{name:'Resume artwork'}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Resume artwork'}).click();
  await page.locator('footer').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('[data-running]')?.getAttribute('data-running')==='false');
  const failure=await browser.newContext();
  await failure.route('**/*', route => {
    const req=route.request();
    if ((req.method()==='POST' && !req.url().startsWith(base)) || req.url().includes('/api/price')) return route.fulfill({status:503,body:'Temporarily unavailable'});
    return route.continue();
  });
  const unavailable=await failure.newPage();
  await unavailable.goto(base+'/devnet/discover');
  await unavailable.getByText('Devnet is not answering',{exact:true}).waitFor();
  assert.equal(await unavailable.getByText('No public requests yet',{exact:true}).count(),0);
  await unavailable.screenshot({path:'/private/tmp/zenlo-refinement-discover-unavailable.png',fullPage:true});
  await failure.close();
  console.log('PASS: ten routes at mobile/tablet/desktop, reduced motion, public Learn isolation, legacy redirect, navigation, image decode, artwork pause/offscreen and unavailable Discover.');
} finally { await browser.close(); }
