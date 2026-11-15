/**
 * THE ROOMS ARE SHUFFLED EVERY DAY, UNLESS FIXED.
 *
 * Ifrah, 2026-11-15: "shuffle the rooms daily … so people are never doing the same rooms
 * unless I have fixed them". With the switch on, each day ahead is dealt fresh: nobody
 * repeats a room from the day before, a Fixed room stays with its cleaner, a hand move
 * stays put, the early cap holds and the load stays level. Off puts the pins back.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/rooms-shuffle-daily.js
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
    { id: 'p1', name: 'Amina', crew: 'Team 1', isCleaner: true, isLeader: true, floors: [], worksOn: [0,1,2,3,4,5,6] },
    { id: 'p2', name: 'Bashir', crew: 'Team 2', isCleaner: true, isLeader: true, floors: [], worksOn: [0,1,2,3,4,5,6] },
    { id: 'p3', name: 'Caasha', crew: 'Team 3', isCleaner: true, isLeader: true, floors: [], worksOn: [0,1,2,3,4,5,6] },
    { id: 'p4', name: 'Dahir', crew: 'Team 4', isCleaner: true, isLeader: true, floors: [], worksOn: [0,1,2,3,4,5,6] },
    { id: 'p5', name: 'Ahmed', crew: 'Lead', isCleaner: true, isLeader: true, noAuto: true, floors: [], worksOn: [0,1,2,3,4,5,6] },
  ],
  teams: [{ name: 'Team 1', color: '#0284c7' }],
  servicedUnits: [
    { id: 'u101', unit: '101', type: 'office', freq: 'daily', days: null, preferEarly: true, usualTo: 'p1', startDate: '2026-01-01' },
    { id: 'u102', unit: '102', type: 'office', freq: 'daily', days: null, preferEarly: true, usualTo: 'p2', startDate: '2026-01-01' },
    { id: 'u103', unit: '103', type: 'office', freq: 'daily', days: null, preferEarly: false, usualTo: 'p3', startDate: '2026-01-01' },
    { id: 'u201', unit: '201', type: 'office', freq: 'daily', days: null, preferEarly: true, usualTo: 'p4', startDate: '2026-01-01' },
    { id: 'u202', unit: '202', type: 'office', freq: 'daily', days: null, preferEarly: false, usualTo: 'p1', startDate: '2026-01-01' },
    { id: 'u203', unit: '203', type: 'office', freq: 'daily', days: null, preferEarly: false, usualTo: 'p2', startDate: '2026-01-01' },
    { id: 'u301', unit: '301', type: 'office', freq: 'daily', days: null, preferEarly: true, usualTo: 'p3', startDate: '2026-01-01' },
    { id: 'u302', unit: '302', type: 'office', freq: 'daily', days: null, preferEarly: false, usualTo: 'p4', startDate: '2026-01-01' },
    { id: 'u303', unit: '303', type: 'office', freq: 'daily', days: null, preferEarly: false, usualTo: 'p1', startDate: '2026-01-01' },
    { id: 'u401', unit: '401', type: 'office', freq: 'daily', days: null, preferEarly: true, usualTo: 'p2', startDate: '2026-01-01' },
  ],
  earlyCap: 2, floors: 11, completions: {}, assignConfirmed: {}, manualArrivals: {}, attendance: {}, plans: {},
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
    const t = workToday();
    const days = []; for (let i = 1; i <= 7; i += 1) days.push(shiftDay(t, i));
    const snap = () => days.map((d) => { const p = state.plans[d] || {}; const o = {}; Object.keys(p).forEach((k) => { if (p[k].kind === 'unit') o[p[k].refId] = p[k].assignedTo; }); return o; });
    const before = snap();
    state.servicedUnits.find((u) => u.id === 'u401').fixed = true;
    setDailyShuffle(true);
    const on = snap();
    // A hand move on day 3, then the day dealt again: it must stay.
    const d3 = days[2];
    setPlanAssignee(d3, 'unit:u202', 'p4');
    shuffleDay(d3, true);
    const handKept = state.plans[d3]['unit:u202'].assignedTo;
    // Same state, same answer: deal day 5 twice.
    const d5 = days[4]; shuffleDay(d5, true); const a = JSON.stringify(snap()[4]); shuffleDay(d5, true); const b = JSON.stringify(snap()[4]);
    const early = new Set(state.servicedUnits.filter((u) => u.preferEarly).map((u) => u.id));
    setDailyShuffle(false);
    const off = snap();
    // Taking a room off a future day (hold it on the Tomorrow view) sticks through a re-sync.
    const d1 = days[0] && Object.keys(state.plans[days[0]] || {}).length ? days[0] : days[1];
    takeRoomOffDay(d1, 'u103'); ensureWeekPlanned();
    const offDay = !state.plans[d1]['unit:u103'];
    const othersStay = Object.keys(state.plans[d1]).filter((k) => k.startsWith('unit:')).length === 9;
    return { offDay, othersStay, before, on, off, handKept, same: a === b, early: [...early], days, usual: Object.fromEntries(state.servicedUnits.map((u) => [u.id, u.usualTo])) };
  });

  const early = new Set(q.early);
  const empty = q.on.filter((d) => !Object.keys(d).length).length;   // the shut day lays out nothing
  const allPlanned = empty <= 1 && q.on.every((d) => !Object.keys(d).length || Object.keys(d).length === 10);
  check('every working day ahead is laid out with all 10 rooms', allPlanned, JSON.stringify(q.on.map((d) => Object.keys(d).length)));
  check('before the switch, rooms follow their regular cleaner', q.before.every((d) => Object.entries(d).every(([u, p]) => p === q.usual[u])));
  let repeats = 0, fixedOk = true, capOk = true, levelOk = true, nobody = 0, changed = 0, ahmed = 0;
  q.on.forEach((d, i) => {
    const load = {}, ear = {};
    Object.entries(d).forEach(([u, p]) => {
      if (!p) { nobody += 1; return; }
      if (p === 'p5') ahmed += 1;
      load[p] = (load[p] || 0) + 1; if (early.has(u)) ear[p] = (ear[p] || 0) + 1;
      if (u === 'u401' && p !== q.usual[u]) fixedOk = false;
      if (u !== 'u401' && p !== q.usual[u]) changed += 1;
      // the last day laid out before this one (Friday has nothing on it)
      let prev = i - 1; while (prev >= 0 && !Object.keys(q.on[prev]).length) prev -= 1;
      if (prev >= 0 && u !== 'u401' && q.on[prev][u] === p) repeats += 1;
    });
    if (Object.values(ear).some((n) => n > 2)) capOk = false;
    const ls = ['p1', 'p2', 'p3', 'p4'].map((p) => load[p] || 0);
    if (Math.max(...ls) - Math.min(...ls) > 1) levelOk = false;
  });
  check('nobody gets the same room two days running (unless fixed)', repeats === 0, repeats + ' repeats');
  check('the rooms actually move off their regular cleaner', changed > 20, changed + ' moved');
  check('a Fixed room stays with its regular cleaner every day', fixedOk);
  check('nobody has more than 2 early rooms', capOk);
  check('the rooms are spread evenly (within one)', levelOk);
  check('every room has somebody', nobody === 0, nobody + ' unassigned');
  check('"rooms by hand only" gets nothing dealt', ahmed === 0);
  check('a hand move survives the day being dealt again', q.handKept === 'p4', q.handKept);
  check('same state, same shuffle (devices agree)', q.same);
  const offOk = q.off.every((d, i) => Object.entries(d).every(([u, p]) => (i === 2 && u === 'u202') ? p === 'p4' : p === q.usual[u]));
  check('switching off puts every room back on its regular cleaner (hand moves stay)', offOk, JSON.stringify(q.off[0]));
  check('a room taken off a future day stays off after a re-sync', q.offDay);
  check('…and the other rooms that day are untouched', q.othersStay);
  check('no console errors', errs.length === 0, errs.join(' | '));

  const failed = results.filter((r) => !r[1]).length;
  console.log((results.length - failed) + ' passed, ' + failed + ' failed');
  await browser.close(); s.close();
  process.exit(failed ? 1 : 0);
})();
