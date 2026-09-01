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

// READ THE PUNCHES, NOT THE REPORT.
// This used to read Attendance -> Time Card, which is not raw data: it is a computed
// attendance report, and it only produces a row for somebody attached to an active
// SCHEDULE. On 31 Aug it went empty — not just for that day, but retroactively, so even
// August read as nothing — while the door reader carried on recording perfectly well.
// The scrape kept succeeding and reporting "rows read: 0", the board showed NO SCAN for
// two days, and nothing anywhere said which of the two had actually failed. A green run
// that reads a report can be a green run that reads somebody's expired shift config.
//
// Transaction is the reader's own log: one row per punch, before any attendance rule is
// applied. It is what the board always wanted anyway — the app only ever takes the
// earliest punch as IN and the latest as OUT — and it cannot be emptied by a schedule.
//
// rows: [First, Last, ID, Dept, Date, Time, Weekday, ...] -> per person/day, the first
// punch (arrival / "In") AND the last punch (departure / "Out"). Both go in as separate
// hik_events rows; the app reads earliest = In, latest = Out.
function parseRows(rows) {
  const byKey = {};   // name|date -> { name, code, date, times[] }
  for (const r of rows) {
    if (r.length < 6) continue;
    const name = ((r[0] || '') + ' ' + (r[1] || '')).trim();
    const code = String(r[2] || '').trim();
    const date = String(r[4] || '').trim().slice(0, 10);
    // One punch per row here, rather than Time Card's semicolon-separated list. Kept as
    // an array so the grouping below is unchanged whichever page it came from.
    const times = String(r[5] || '').trim().match(/\d{1,2}:\d{2}/g) || [];
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !times.length) continue;
    const key = name.toLowerCase() + '|' + date;
    if (!byKey[key]) byKey[key] = { name, code, date, times: [] };
    byKey[key].times.push(...times);
  }
  // TWO PUNCHES A MINUTE APART ARE ONE ARRIVAL. People scan twice — the reader does not
  // beep, or they badge again on the way past — and reading the last punch of the day as
  // a DEPARTURE turns that into "arrived 05:59, left 06:00" and the board says they have
  // gone home before the round has started. Time Card collapsed these itself; the raw log
  // hands over every punch, so the collapsing has to happen here.
  //
  // An hour is the threshold: nobody on this crew arrives and genuinely leaves inside one,
  // and a real departure is hours away from the arrival. Below it, there is one event —
  // the arrival — and no out at all.
  const MIN_OUT_GAP_MIN = 60;
  const mins = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t);
    return m ? (Number(m[1]) * 60 + Number(m[2])) : null;
  };
  const out = [];
  for (const v of Object.values(byKey)) {
    const sorted = v.times.slice().sort();   // "HH:MM" 24h zero-padded → lexical = chronological
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const gap = (mins(first) === null || mins(last) === null) ? 0 : (mins(last) - mins(first));
    out.push({ person_name: v.name, person_code: v.code, event_time: v.date + ' ' + first + ':00', event_type: 'scraped', raw: { source: 'scraper', kind: 'in' } });
    if (last && last !== first && gap >= MIN_OUT_GAP_MIN) {
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

    console.log('2. Attendance → Transaction…');
    await page.getByText('Attendance', { exact: true }).first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await page.click('button:has-text("OK")', { timeout: 4000 }).catch(() => {});
    await page.click('text=Attendance Records', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.click('text=Transaction', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(5000);
    await page.click('button:has-text("OK")', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, 'transaction.png');

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
    // A ROW PER PUNCH, NOT PER DAY. Time Card gave one row per person per day; this
    // gives one per punch, in and out, so a crew of seventeen is already past fifty.
    await page.click('.el-select-dropdown__item:has-text("100")', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await shot(page, 'transaction-today.png');

    const all = await page.$$eval('.el-table__body-wrapper tr', trs =>
      trs.map(tr => Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim()))
         .filter(r => r.length >= 6 && r.some(c => c)));
    console.log('   rows read:', all.length);
    // AN EMPTY PAGE IS NEWS. Two days were lost to a scrape that succeeded, read nothing
    // and said so in a line nobody was watching. The reader records all day; if this is
    // empty during working hours, something upstream has broken and the run should look
    // like a problem rather than a success.
    if (!all.length) console.log('   ⚠ NOTHING ON THE PAGE. The reader records all day, so an empty '
      + 'Transaction log means the punches are not reaching Hik — check the device is on the network.');

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
