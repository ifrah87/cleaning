/**
 * ONCE A ROOM IS ALLOCATED IT STAYS ALLOCATED.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/allocation-locks.js
 *
 * The morning hand-out deletes today's sign-off stamp from every room it deals, and
 * maybeAutoAssign only protected rooms carrying that stamp — so an automatically dealt
 * room was never safe. The next person to badge in put the whole morning back in the pool
 * and split it again, moving rooms off cleaners who were already working them, and in one
 * case off a cleaner who had ALREADY CLEANED the room.
 *
 * A room with a name on it keeps that name. Only rooms nobody holds are dealt to whoever
 * turns up next — and a room held by somebody marked AWAY still goes back in the pool,
 * because that is a gap and not a decision.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';
const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const WORK_TODAY = (() => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); return key(d); })();
// NOT A FRIDAY, EVER. "Cleaned the day before" is how nearly every fixture here makes a
// room due today — and the daily rooms are cleaned on the Friday in advance of the
// Saturday, so on a Saturday that clean covers today and the room is deliberately NOT
// due. A fixture pinned to literal yesterday therefore passes six days a week and fails
// on the seventh, taking the board, the hand-out and the levelling tests down with it
// for reasons that have nothing to do with what they are testing. Step back past a
// Friday so "recently cleaned, due today" means that whatever day the suite is run.
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); while (d.getDay() === 5) d.setDate(d.getDate() - 1); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const APP_STATE = {
  staff: [
    { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [], hikPersonId: 'h1', canClean: ['building', 'office', 'airbnb'] },
    { id: 'p2', name: 'Hodan Omar', crew: 'Team B', isCleaner: true, isLeader: true, floors: [], hikPersonId: 'h2', canClean: ['building', 'office', 'airbnb'] },
  ],
  servicedUnits: [
    { id: 'su201', unit: '201', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
    { id: 'su202', unit: '202', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
    { id: 'su203', unit: '203', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
    { id: 'su204', unit: '204', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
    // ...and one nobody holds, which IS the newcomer's to take.
    { id: 'su205', unit: '205', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE },
  ],
  areas: [{ id: 'corridors', label: 'Corridors', kind: 'interior', freq: 'daily', assignedTo: 'p1' }],
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  rollCallTypes: ['office', 'building'],   // as in the building: Airbnb is its own job
};
const EVENTS = [
  { person_name: 'Amina Yusuf', person_code: '1', event_time: WORK_TODAY + ' 06:30:00' },
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
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

  console.log('\n\x1b[1mOnce a room is allocated it does not move\x1b[0m');

  const holdings = () => page.evaluate(() => {
    const m = {};
    state.servicedUnits.forEach((u) => { m[u.unit] = u.assignedTo || null; });
    return m;
  });

  const before = await holdings();
  check('Amina starts holding 201-204',
    ['201', '202', '203', '204'].every((n) => before[n] === 'p1'), JSON.stringify(before));

  // --- somebody new badges in, an hour into the morning ------------------------
  await page.evaluate(() => {
    hikArrivals['p2'] = { time: '07:35', raw: '07:35' };
    state.autoAssignedFor = null;      // a new crew: the morning would deal again
    maybeAutoAssign();
  });
  await page.waitForTimeout(900);
  const after = await holdings();

  const moved = ['201', '202', '203', '204'].filter((n) => after[n] !== 'p1');
  check('not one of Amina\'s four rooms has moved off her', moved.length === 0,
    'moved: ' + moved.map((n) => n + ' -> ' + after[n]).join(', ') + '  ' + JSON.stringify(after));

  // --- but the newcomer is not left idle --------------------------------------
  check('the room nobody held has been dealt out', !!after['205'], JSON.stringify(after));

  // --- a room held by somebody AWAY is still a gap, not a decision -------------
  // AWAY = ['noshow', 'sick'] — 'away' is not a status the app knows.
  await page.evaluate(() => {
    state.attendance = Object.assign({}, state.attendance, { p1: 'noshow' });
    state.autoAssignedFor = null;
    maybeAutoAssign();
  });
  await page.waitForTimeout(900);
  const away = await holdings();
  check('rooms held by somebody marked away go back in the pool',
    ['201', '202', '203', '204'].every((n) => away[n] !== 'p1'), JSON.stringify(away));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
