const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto('https://ieu.hik-connect.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    // click Log In
    await page.click('text=Log In', { timeout: 15000 }).catch(()=>{});
    await page.waitForTimeout(6000);
    console.log('URL after Log In:', page.url());
    await page.screenshot({ path: __dirname + '/login-form.png', fullPage: true });
    const inputs = await page.$$eval('input', els => els.map(e => ({ type: e.type, placeholder: e.placeholder, cls: e.className, name: e.name })));
    const buttons = await page.$$eval('button', els => els.map(e => (e.innerText||'').trim()).filter(Boolean).slice(0,12));
    console.log('INPUTS:', JSON.stringify(inputs));
    console.log('BUTTONS:', JSON.stringify(buttons));
  } catch (e) { console.log('ERR:', e.message); }
  await browser.close();
})();
