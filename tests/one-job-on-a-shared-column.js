/**
 * A SHARED JOB IS ONE JOB, EVEN WHEN THE PEOPLE ON IT SHARE A COLUMN.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/one-job-on-a-shared-column.js
 *
 * A communal walk is pushed into the list of everybody named on it — deliberately, so a
 * cleaner on the corridors can see the corridors in their own column. A crew with no
 * leader is drawn as ONE card with both names on it, and that card is their lists run
 * together. Put those two together and a walk the pair share came out twice on the one
 * card: "Trash / Recycling + Nur" above "Trash / Recycling + Mohamed", counted 0/2 for
 * a single bin round. The tally at the top was right the whole time — countJobs dedupes
 * — which is why it went unnoticed until the office actually put the outside team on a
 * shared job.
 *
 * SAFETY: never touches the live Supabase project; every request is answered locally.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';
const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const WORK_TODAY = (() => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); return key(d); })();
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); while (d.getDay() === 5) d.setDate(d.getDate() - 1); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const APP_STATE = {
  staff: [
    { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [1], hikPersonId: 'h1' },
    // THE OUTSIDE PAIR. No leader between them, which is what makes the board draw
    // them as one card — the real crew this broke on.
    { id: 'p2', name: 'Salaal Nuur', crew: 'Outside team', isCleaner: true, isLeader: false, floors: [], hikPersonId: 'h2' },
    { id: 'p3', name: 'Sidow Cali', crew: 'Outside team', isCleaner: true, isLeader: false, floors: [], hikPersonId: 'h3' },
  ],
  servicedUnits: [
    { id: 'su101', unit: '101', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
  ],
  // One walk, answered for by Salaal, with Sidow on it alongside him.
  areas: [{ id: 'trash', label: 'Trash / Recycling', kind: 'interior', freq: 'daily', assignedTo: 'p2', assignedWith: ['p3'] }],
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  rollCallTypes: ['office', 'building'],
};
const EVENTS = [
  { person_name: 'Amina Yusuf', person_code: '1', event_time: WORK_TODAY + ' 06:30:00' },
  { person_name: 'Salaal Nuur', person_code: '2', event_time: WORK_TODAY + ' 06:35:00' },
  { person_name: 'Sidow Cali', person_code: '3', event_time: WORK_TODAY + ' 06:40:00' },
];

function serve() {
  return new Promise((r) => {
    const s = http.createServer((q, res) => {
      const f = q.url.split('?')[0] === '/' ? '/index.html' : q.url.split('?')[0];
      const p = path.join(ROOT, f);
      if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'text/plain' });
      res.end(fs.readFileSync(p));
    });
    s.listen(0, '127.0.0.1', () => r({ s, port: s.address().port }));
  });
}

const out = [];
const check = (n, c, d) => { out.push([n, !!c]); console.log((c ? '  \x1b[32mPASS\x1b[0m ' : '  \x1b[31mFAIL\x1b[0m ') + n + (c || !d ? '' : '\n       ' + d)); };

(async () => {
  const { s, port } = await serve();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(`**://${SUPA_HOST}/**`, async (route) => {
    const req = route.request(), url = req.url(), m = req.method();
    const json = (b, st = 200) => route.fulfill({ status: st, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(b) });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }, body: '' });
    if (url.includes('/auth/v1/token')) return json(SESSION);
    if (url.includes('/auth/v1/user')) return json(SESSION.user);
    if (url.includes('/rest/v1/app_state')) {
      if (m === 'GET') {
        const single = String(req.headers()['accept'] || '').includes('pgrst.object');
        return json(single ? { data: APP_STATE } : [{ data: APP_STATE }]);
      }
      return json([{}], 201);
    }
    if (url.includes('/rest/v1/hik_events')) return json(m === 'GET' ? EVENTS : [{}]);
    return json([]);
  });
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.header', { timeout: 20000 });
  await page.waitForTimeout(3000);

  console.log('\n\x1b[1mOne shared walk, on one shared card, once\x1b[0m');

  const cols = await page.evaluate(() => tvColumns().map((c) => ({
    name: c.name, jobs: c.jobs.map((j) => j.label),
  })));
  const pair = cols.find((c) => /Salaal/.test(c.name) && /Sidow/.test(c.name));

  check('the pair with no leader share one card', !!pair, cols.map((c) => c.name).join(' | '));
  check('...and the walk they share is on it once',
    !!pair && pair.jobs.filter((l) => /^Trash \/ Recycling/.test(l)).length === 1,
    pair ? JSON.stringify(pair.jobs) : 'no pair column');
  check('...still naming the other person on it',
    !!pair && pair.jobs.some((l) => /^Trash \/ Recycling \+ \w/.test(l)),
    pair ? JSON.stringify(pair.jobs) : 'no pair column');
  check('...so the card counts one job, not two',
    !!pair && pair.jobs.length === 1, pair ? pair.jobs.length + ' jobs' : 'no pair column');

  // The tally has always been right; it must stay right, and now agree with the card.
  check('and the board’s own total says one walk and one room',
    await page.evaluate(() => countJobs(tvColumns()).all) === 2,
    JSON.stringify(await page.evaluate(() => countJobs(tvColumns()))));

  // A walk shared by people who are NOT merged into one card must still appear for each
  // of them — that is the behaviour the dedupe must not undo.
  const both = await page.evaluate(() => {
    const a = state.areas.find((x) => x.id === 'trash');
    a.assignedTo = 'p1'; a.assignedWith = ['p2'];     // a leader and one of the outside pair
    render();
    return tvColumns().map((c) => ({ name: c.name, n: c.jobs.filter((j) => /^Trash/.test(j.label)).length }));
  });
  check('a walk shared across two cards is on both of them',
    both.filter((c) => c.n === 1).length === 2 && !both.some((c) => c.n > 1),
    JSON.stringify(both));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
