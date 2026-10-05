/**
 * CHANGING WHO CLEANS A ROOM IS ONE TAP AND IT STICKS.
 *
 * Ifrah, 2026-10-05: "I want to be able to reshuffle the rooms easily… change the
 * cleaner that cleans a room — right now it seems so rigid." Tap the room on the Team
 * page, tap the new cleaner: the room's own cleaner, today's board (if not cleaned yet)
 * and every day already planned all change together.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/a-room-changes-cleaner.js
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';
const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
// THE WORK DAY, NOT THE CALENDAR DAY — the app's day turns over at 3am.
const WORK_TODAY = (() => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); return key(d); })();
// NOT A FRIDAY, EVER. "Cleaned the day before" is how nearly every fixture here makes a
// room due today — and the daily rooms are cleaned on the Friday in advance of the
// Saturday, so on a Saturday that clean covers today and the room is deliberately NOT
// due. A fixture pinned to literal yesterday therefore passes six days a week and fails
// on the seventh, taking the board, the hand-out and the levelling tests down with it
// for reasons that have nothing to do with what they are testing. Step back past a
// Friday so "recently cleaned, due today" means that whatever day the suite is run.
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); while (d.getDay() === 5) d.setDate(d.getDate() - 1); return key(d); })();

// A Friday comfortably in the future, so every date the schedule is questioned about
// is on the same side of "today" whatever day this test is run on. The carry-forward
// for outstanding work only applies up to today, and mixing the two sides of that
// line is how a schedule test comes out differently on a Tuesday.
const FRI = (() => { const d = new Date(WORK_TODAY + 'T12:00:00'); d.setDate(d.getDate() + 8); while (d.getDay() !== 5) d.setDate(d.getDate() + 1); return key(d); })();
const shift = (day, n) => { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() + n); return key(d); };
const THU = shift(FRI, -1), SAT = shift(FRI, 1), SUN = shift(FRI, 2), MON = shift(FRI, 3);

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1e3) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

const APP_STATE = {
  staff: [
    { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [] },
    { id: 'p2', name: 'Bashir Ali', crew: 'Team B', isCleaner: true, isLeader: true, floors: [] },
    { id: 'p3', name: 'Abukar Daud', crew: 'Team H', isCleaner: true, isLeader: true, floors: [] },
    { id: 'p4', name: 'Mahamed Abiker', crew: 'Team H', isCleaner: true, isLeader: true, floors: [] },
    { id: 'p5', name: 'Zakaria Helper', crew: 'Team A', isCleaner: true, isLeader: false, floors: [] },
  ],
  teams: [{ name: 'Team A', color: '#0284c7', floors: [] }, { name: 'Team B', color: '#15803d', floors: [] }, { name: 'Team H', color: '#b45309', floors: [] }],
  servicedUnits: [],
  floors: 11, completions: {}, assignConfirmed: {}, manualArrivals: {}, attendance: {}, plans: {},
};

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
const results = [];
const check = (n, ok, d) => { results.push([n, !!ok]); console.log((ok ? '  \x1b[32mPASS\x1b[0m ' : '  \x1b[31mFAIL\x1b[0m ') + n + (ok || !d ? '' : '\n         ' + d)); };

(async () => {
  const { s, port } = await serve();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.route(`**://${SUPA_HOST}/**`, async (route) => {
    const req = route.request(), url = req.url(), m = req.method();
    const json = (b, st = 200) => route.fulfill({ status: st, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(b) });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }, body: '' });
    if (url.includes('/auth/v1/token')) return json(SESSION);
    if (url.includes('/auth/v1/user')) return json(SESSION.user);
    if (url.includes('/rest/v1/app_state')) {
      if (m === 'GET') { const single = String(req.headers()['accept'] || '').includes('pgrst.object'); return json(single ? { data: APP_STATE } : [{ data: APP_STATE }]); }
      return json([{}], 201);                 // swallowed — this test never writes anything back
    }
    if (url.includes('/rest/v1/hik_events')) return json([]);
    if (url.includes('/rest/v1/cleaning_log')) return json([], m === 'POST' ? 201 : 200);
    return json([]);
  });
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.header', { timeout: 20000 });
  await page.waitForTimeout(3000);

  const q = await page.evaluate(async () => {
    const t = workToday(), y = shiftDay(t, -1), t1 = shiftDay(t, 1), t2 = shiftDay(t, 2);
    const job = (u, who) => ({ kind: 'unit', refId: u, label: 'Unit ' + u, assignedTo: who, auto: true });
    state.servicedUnits = [
      { id: 'r1', unit: '301', type: 'office', freq: 'daily', usualTo: 'p1', assignedTo: 'p1', lastCleaned: y },
      { id: 'r2', unit: '302', type: 'office', freq: 'daily', usualTo: 'p1', assignedTo: 'p1', lastCleaned: t },
    ];
    state.plans = {};
    [y, t, t1, t2].forEach((d) => { state.plans[d] = { 'unit:r1': job('r1', 'p1'), 'unit:r2': job('r2', 'p1') }; });
    const r = {};
    moveRoomTo('r1', 'p2');
    const u1 = state.servicedUnits[0], u2 = state.servicedUnits[1];
    r.usual = u1.usualTo; r.stamped = !!u1.editedAt; r.today = u1.assignedTo;
    r.planToday = state.plans[t]['unit:r1'].assignedTo; r.planT1 = state.plans[t1]['unit:r1'].assignedTo;
    r.planT2 = state.plans[t2]['unit:r1'].assignedTo; r.planY = state.plans[y]['unit:r1'].assignedTo;
    moveRoomTo('r2', 'p2');
    r.doneUsual = u2.usualTo; r.doneToday = u2.assignedTo; r.donePlanToday = state.plans[t]['unit:r2'].assignedTo;
    r.donePlanT1 = state.plans[t1]['unit:r2'].assignedTo;
    topUpTodayPlan();
    r.afterResync = u1.assignedTo + '/' + state.plans[t]['unit:r1'].assignedTo;
    const g = roomOwnerGroups();
    r.groups = g.map((x) => x.name);
    // Through the screen, the way the office does it.
    setTab('team'); await new Promise((ok) => setTimeout(ok, 300));
    r.panel = /Who cleans which room/.test(document.body.textContent);
    const chip = [...document.querySelectorAll('button.freqmini')].find((b) => b.textContent.trim() === '301');
    chip.click(); await new Promise((ok) => setTimeout(ok, 300));
    r.sheet = (document.querySelector('.modal-title') || {}).textContent || '';
    const opt = [...document.querySelectorAll('.cover-opt')].find((b) => /Abukar Daud \/ Mahamed Abiker/.test(b.textContent));
    opt.click(); await new Promise((ok) => setTimeout(ok, 300));
    r.viaScreen = u1.usualTo + '/' + state.plans[t1]['unit:r1'].assignedTo;
    r.sheetGone = !document.querySelector('.modal-title');
    return r;
  });

  check('the room is now the new cleaner\'s, from today on', q.usual === 'p2');
  check('…stamped, so another phone cannot put it back', q.stamped);
  check('…today\'s board changes', q.today === 'p2' && q.planToday === 'p2', q.today + ' ' + q.planToday);
  check('…and every day already planned', q.planT1 === 'p2' && q.planT2 === 'p2', q.planT1 + ' ' + q.planT2);
  check('…but yesterday\'s record is left alone', q.planY === 'p1');
  check('a room already cleaned today keeps who cleaned it today', q.doneToday === 'p1' && q.donePlanToday === 'p1', q.doneToday + ' ' + q.donePlanToday);
  check('…and moves from tomorrow', q.doneUsual === 'p2' && q.donePlanT1 === 'p2');
  check('the five-minute re-sync does not move it back', q.afterResync === 'p2/p2', q.afterResync);
  check('equal leaders on one team are one choice, assistants none', q.groups.length === 3 && q.groups.includes('Abukar Daud / Mahamed Abiker') && !q.groups.some((n) => /Zakaria/.test(n)), JSON.stringify(q.groups));
  check('the Team page shows "Who cleans which room"', q.panel);
  check('tapping a room asks who should clean it', /Who should clean 301/.test(q.sheet), q.sheet);
  check('tapping a team moves it there, today and ahead', q.viaScreen === 'p3/p3', q.viaScreen);
  check('…and the sheet closes', q.sheetGone);
  check('no console errors', errs.filter((e) => !/airbnb-stays|ERR_FAILED/.test(e)).length === 0, errs.join(' | '));

  const failed = results.filter((r) => !r[1]).length;
  console.log((results.length - failed) + ' passed, ' + failed + ' failed');
  await browser.close(); s.close();
  process.exit(failed ? 1 : 0);
})();
