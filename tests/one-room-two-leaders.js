/**
 * A SHARED JOB IS ONE JOB, EVEN WHEN THE PEOPLE ON IT SHARE A COLUMN.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/one-room-two-leaders.js
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
    { id: 'p2', name: 'Salaal Nuur', crew: 'Team B', isCleaner: true, isLeader: true, floors: [2], hikPersonId: 'h2' },
    { id: 'p3', name: 'Sidow Cali', crew: 'Team C', isCleaner: true, isLeader: true, floors: [3], hikPersonId: 'h3' },
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

  console.log('\n\x1b[1mOne big room, two team leaders\x1b[0m');

  const shared = await page.evaluate(() => {
    const u = state.servicedUnits.find((x) => x.id === 'su101');
    u.assignedTo = 'p1';
    toggleRoomHelper('su101', 'p2');           // share it with a second leader
    const cols = tvColumns();
    const col = (n) => cols.find((c) => new RegExp(n).test(c.name)) || { jobs: [] };
    return {
      owner: col('Amina').jobs.map((j) => j.label + (j.helper ? ' [helper]' : '')),
      mate: col('Salaal').jobs.map((j) => j.label + (j.helper ? ' [helper]' : '')),
      total: countJobs(cols).all,
      stored: u.assignedWith,
    };
  });
  check('it is on the owner\'s card', shared.owner.some((l) => /^101/.test(l)), JSON.stringify(shared));
  check('...and on the second leader\'s card too', shared.mate.some((l) => /^101/.test(l)),
    JSON.stringify(shared));
  check('...marked as help, not a round of their own',
    shared.mate.some((l) => /\[helper\]/.test(l)), JSON.stringify(shared));
  check('...each card naming the other person',
    shared.owner.some((l) => /\+ Salaal/.test(l)) && shared.mate.some((l) => /\+ Amina/.test(l)),
    JSON.stringify(shared));
  // The fixture also holds one communal walk, so the building's total is 2 — the point
  // is that the shared ROOM contributes one, not two, however many columns it sits in.
  check('...and the building still counts the room ONCE', shared.total === 2, String(shared.total));

  // Either of them ticking it finishes it — the tick is the room's, not the person's.
  const ticked = await page.evaluate(() => {
    const cols = tvColumns();
    const mate = cols.find((c) => /Salaal/.test(c.name));
    const job = mate.jobs.find((j) => /^101/.test(j.label));
    toggleServicedDone(job.id);
    const after = tvColumns();
    return after.map((c) => ({ n: c.name, done: c.jobs.filter((j) => j.done).length }));
  });
  check('either of them ticking it finishes it for both',
    ticked.filter((c) => c.done > 0).length === 2, JSON.stringify(ticked));

  // Giving the room to the helper must not leave them named alongside themselves.
  const handed = await page.evaluate(() => {
    setUnitAssignee('su101', 'p2');
    const u = state.servicedUnits.find((x) => x.id === 'su101');
    return { owner: u.assignedTo, with: u.assignedWith };
  });
  check('handing it to the helper clears them from the shared list',
    handed.owner === 'p2' && !handed.with, JSON.stringify(handed));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
