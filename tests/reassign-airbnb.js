/**
 * AIRBNB ROOMS CAN BE HANDED TO SOMEBODY FOR A DAY.
 *
 * Ifrah, 2026-11-04: "I want to be able to allocate Airbnb rooms" (to Ahmed Daahir). They
 * stay off the roll call; ⇄ Reassign offers them for Today and Tomorrow, not From now on.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/reassign-airbnb.js
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
  staff: [{ id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [] }],
  teams: [{ name: 'Team A', color: '#0284c7', floors: [] }],
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

  const q = await page.evaluate(() => {
    const out = {}, t = workToday(), tm = shiftDay(t, 1);
    state.rollCallTypes = ['office'];
    state.attendance = { p1: 'present' };
    state.staff.push({ id: 'p2', name: 'Ahmed Test', crew: 'Lead', isCleaner: true, isLeader: true, noAuto: true, floors: [] });
    hikArrivals.p2 = { first: '13:00' }; hikArrivals.p1 = { first: '07:00' };
    const mk = (id, unit, type) => ({ id, unit, type, freq: 'daily', days: null, lastCleaned: shiftDay(t, -1) });
    state.servicedUnits.push(mk('o1', '704', 'office'), mk('a1', '406', 'airbnb'), mk('a2', '506', 'airbnb'), mk('a3', '606', 'airbnb'));
    state.servicedUnits.find((u) => u.id === 'a3').paused = true;
    const ids = (w) => reassignRooms(w).map((u) => u.id);
    out.offeredToday = ids('today').indexOf('a1') >= 0 && ids('tomorrow').indexOf('a1') >= 0;
    out.notAlways = ids('always').indexOf('a1') < 0;
    out.notPaused = ids('today').indexOf('a3') < 0;

    _reassign = { when: 'today', ids: ['a1'], done: '' }; applyReassign('p2'); _reassign = null;
    const box = (cols, n) => (cols.find((c) => c.name.indexOf(n) >= 0) || { jobs: [] }).jobs.map((j) => j.id);
    out.todayBox = box(tvColumns(), 'Ahmed').indexOf('a1') >= 0;
    out.notOnAirPage = tvAirDue(tvColumns()).every((u) => u.id !== 'a1');
    out.otherStaysOnAirPage = tvAirDue(tvColumns()).some((u) => u.id === 'a2');

    _reassign = { when: 'tomorrow', ids: ['a2'], done: '' }; applyReassign('p2'); _reassign = null;
    out.tomorrowBox = box(tvColumnsForDay(tm), 'Ahmed').indexOf('a2') >= 0;
    out.a2NotToday = box(tvColumns(), 'Ahmed').indexOf('a2') < 0;

    // The morning it arrives: only the plan says so, until the board is filled from it.
    const pl = getPlan(t);
    pl['unit:a2'] = { kind: 'unit', refId: 'a2', label: 'Unit 506', assignedTo: 'p2', byHand: true };
    out.plannedCounts = plannedRoomsToday().rooms.some((u) => u.id === 'a2');
    mirrorPlanToBoard(t, null, true);
    out.morningBox = box(tvColumns(), 'Ahmed').indexOf('a2') >= 0;

    // A plan entry nobody handed out must not drag an Airbnb room onto the crew's list.
    pl['unit:a2'] = { kind: 'unit', refId: 'a2', label: 'Unit 506', assignedTo: null };
    out.unhandedStaysOff = !plannedRoomsToday().rooms.some((u) => u.id === 'a2');
    return out;
  });
  check('Today and Tomorrow offer Airbnb rooms', q.offeredToday);
  check('From now on does not', q.notAlways);
  check('a paused flat is not offered', q.notPaused);
  check('handed out today, it is in their box', q.todayBox);
  check('and off the separate Airbnb page', q.notOnAirPage);
  check('flats nobody was given stay on that page', q.otherStaysOnAirPage);
  check('handed out for tomorrow, it is in their box tomorrow', q.tomorrowBox);
  check('and not today', q.a2NotToday);
  check('on the morning itself the plan brings it in', q.plannedCounts);
  check('and it lands in their box', q.morningBox);
  check('a plan entry nobody handed out stays off the crew list', q.unhandedStaysOff);
  check('no console errors', errs.length === 0, errs.join(' | '));
  const failed = results.filter((r) => !r[1]).length;
  console.log((results.length - failed) + ' passed, ' + failed + ' failed');
  await browser.close(); s.close();
  process.exit(failed ? 1 : 0);
})();
