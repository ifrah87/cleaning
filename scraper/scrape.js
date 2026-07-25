// Hik-Connect for Teams scraper — logs in as you, reads the Time Card,
// and pushes each person's first check-in per day into Supabase (hik_events).
// Real Chromium via Playwright, so it handles Hik's encrypted login.
// Run:  node scrape.js        (headless)
//       node scrape.js --show (visible browser, for debugging)

const { chromium } = require('playwright');
const fs = require('fs');
// Config comes from config.json locally, or from environment variables in the
// cloud (GitHub Actions), so no secrets ever live in the repo.
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));
  } catch (e) {
    const env = process.env;
    if (!env.HIK_EMAIL || !env.HIK_PASSWORD || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
      throw new Error('No config.json and missing HIK_EMAIL/HIK_PASSWORD/SUPABASE_URL/SUPABASE_SERVICE_KEY env vars');
    }
    return {
      hik: { email: env.HIK_EMAIL, password: env.HIK_PASSWORD },
      supabase: { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY },
    };
  }
}
const cfg = loadConfig();
const shot = (p, n) => p.screenshot({ path: __dirname + '/' + n, fullPage: true }).catch(() => {});

// rows: [First, Last, ID, Dept, Date, Weekday, Records] -> per person/day, the
// first punch (arrival / "In") AND the last punch (departure / "Out"). Both go in
// as separate hik_events rows; the app reads earliest = In, latest = Out.
function parseRows(rows) {
  const byKey = {};   // name|date -> { name, code, date, times[] }
  for (const r of rows) {
    if (r.length < 7) continue;
    const name = ((r[0] || '') + ' ' + (r[1] || '')).trim();
    const code = String(r[2] || '').trim();
    const date = String(r[4] || '').trim().slice(0, 10);
    const times = String(r[6] || '').split(/[;,]/).map(t => t.trim()).filter(t => /\d{1,2}:\d{2}/.test(t));
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !times.length) continue;
    const key = name.toLowerCase() + '|' + date;
    if (!byKey[key]) byKey[key] = { name, code, date, times: [] };
    byKey[key].times.push(...times);
  }
  const out = [];
  for (const v of Object.values(byKey)) {
    const sorted = v.times.slice().sort();   // "HH:MM" 24h zero-padded → lexical = chronological
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    out.push({ person_name: v.name, person_code: v.code, event_time: v.date + ' ' + first + ':00', event_type: 'scraped', raw: { source: 'scraper', kind: 'in' } });
    if (last && last !== first) {
      out.push({ person_name: v.name, person_code: v.code, event_time: v.date + ' ' + last + ':00', event_type: 'scraped-out', raw: { source: 'scraper', kind: 'out' } });
    }
  }
  return out;
}

async function push(records) {
  if (!records.length) return 0;
  const res = await fetch(cfg.supabase.url + '/rest/v1/hik_events?on_conflict=person_name,event_time', {
    method: 'POST',
    headers: {
      apikey: cfg.supabase.serviceKey,
      Authorization: 'Bearer ' + cfg.supabase.serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(records),
  });
  if (!res.ok) throw new Error('Supabase push failed: ' + res.status + ' ' + (await res.text()));
  return records.length;
}

async function run() {
  const headless = !process.argv.includes('--show');
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    console.log('1. Login…');
    await page.goto('https://ieu.hik-connect.com/views/login/index.html#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    await page.click('button:has-text("Accept All")', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.fill('input[placeholder="Account/Email"]', cfg.hik.email);
    await page.fill('input[placeholder="Password"]', cfg.hik.password);
    await page.click('button:has-text("Login")');
    await page.waitForTimeout(9000);
    if (!page.url().includes('/portal')) { await shot(page, 'error.png'); throw new Error('Login failed — check credentials (error.png).'); }
    await page.click('button:has-text("Later")', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);

    console.log('2. Attendance → Time Card…');
    await page.getByText('Attendance', { exact: true }).first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await page.click('button:has-text("OK")', { timeout: 4000 }).catch(() => {});
    await page.click('text=Attendance Records', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.click('text=Time Card', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(5000);
    await page.click('button:has-text("OK")', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, 'timecard.png');

    console.log('3. Filtering to Today…');
    // Time Period -> Today (Element-UI mirrors the value into the input's title attr)
    await page.click('input[title="Current Month"]', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.click('.el-select-dropdown__item:has-text("Today")', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.click('button:has-text("Filter")', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(4000);
    // page size -> 50 so all of today's rows fit on one page
    await page.click('input[title="20"]', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.click('.el-select-dropdown__item:has-text("50")', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await shot(page, 'timecard-today.png');

    const all = await page.$$eval('.el-table__body-wrapper tr', trs =>
      trs.map(tr => Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim()))
         .filter(r => r.length >= 6 && r.some(c => c)));
    console.log('   rows read:', all.length);

    const records = parseRows(all);
    console.log('4. Pushing', records.length, 'check-ins to Supabase…');
    const n = await push(records);
    const days = [...new Set(records.map(r => r.event_time.slice(0, 10)))].sort();
    console.log('✅ Done. Pushed ' + n + ' records across ' + days.length + ' day(s): ' + (days[0] || '-') + ' … ' + (days[days.length - 1] || '-'));
  } catch (e) {
    console.log('ERROR:', e.message);
    await shot(page, 'error.png');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
run();
