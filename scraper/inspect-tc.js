const { chromium } = require('playwright');
const cfg = require('./config.json');
(async () => {
  const b = await chromium.launch({ headless: true });
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto('https://ieu.hik-connect.com/views/login/index.html#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    await page.click('button:has-text("Accept All")', { timeout: 6000 }).catch(()=>{});
    await page.fill('input[placeholder="Account/Email"]', cfg.hik.email);
    await page.fill('input[placeholder="Password"]', cfg.hik.password);
    await page.click('button:has-text("Login")'); await page.waitForTimeout(9000);
    await page.click('button:has-text("Later")', { timeout: 5000 }).catch(()=>{});
    await page.getByText('Attendance', { exact: true }).first().click().catch(()=>{}); await page.waitForTimeout(4000);
    await page.click('button:has-text("OK")', { timeout: 4000 }).catch(()=>{});
    await page.click('text=Attendance Records').catch(()=>{}); await page.waitForTimeout(1500);
    await page.click('text=Time Card').catch(()=>{}); await page.waitForTimeout(5000);
    await page.click('button:has-text("OK")', { timeout: 3000 }).catch(()=>{});
    // el-select values
    const selects = await page.$$eval('input.el-input__inner', els => els.map(e => e.value).filter(Boolean));
    console.log('SELECT VALUES:', JSON.stringify(selects));
    // pagination
    const pag = await page.$$eval('.el-pagination', els => els.map(e => e.outerHTML.slice(0, 600)));
    console.log('PAGINATION:', JSON.stringify(pag));
    const totalTxt = await page.$$eval('.el-pagination__total, .el-pagination', els => els.map(e=>e.innerText.trim()).filter(Boolean));
    console.log('PAG TEXT:', JSON.stringify(totalTxt));
  } catch (e) { console.log('ERR', e.message); }
  await b.close();
})();
