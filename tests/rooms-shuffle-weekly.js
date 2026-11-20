/**
 * ONCE A WEEK: THE SAME ROOMS FROM SATURDAY TO THURSDAY, DEALT AGAIN EACH SATURDAY.
 *
 * Ifrah, 2026-11-20: "maybe we should shuffle once a week". The daily shuffle gave every
 * room a new cleaner every day. In week mode each room has one person for the whole week
 * (unless they are not in that day), a new Saturday deals it to somebody else, a Fixed
 * room stays put, the early cap holds and the load stays level.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/rooms-shuffle-weekly.js
 *
 * (Fixture shared with rooms-shuffle-daily.js:)
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
    { id: 'p4', name: 'Dahir', crew: 'Team 4', isCleaner: true, isLeader: true, floors: [], worksOn: [0,2,3,4,5,6] },
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
    state.servicedUnits.find((u) => u.id === 'u401').fixed = true;
    setDailyShuffle(true);
    setShuffleMode('week');
    ensureWeekPlanned(14);
    const t = workToday();
    const days = []; for (let i = 1; i <= 14; i += 1) days.push(shiftDay(t, i));
    const out = days.map((d) => { const p = state.plans[d] || {}; const o = {}; Object.keys(p).forEach((k) => { if (p[k].kind === 'unit') o[p[k].refId] = p[k].assignedTo; }); return { d, week: weekStartOf(d), dow: new Date(d + 'T12:00:00').getDay(), o }; });
    const mode = state.dailyShuffle.mode;
    const maps = Object.keys(state.dailyShuffle.weekMaps || {});
    setShuffleMode('day');
    const backToDaily = state.dailyShuffle.mode === 'day';
    return { out, mode, maps, backToDaily, usual: Object.fromEntries(state.servicedUnits.map((u) => [u.id, u.usualTo])),
      early: state.servicedUnits.filter((u) => u.preferEarly).map((u) => u.id) };
  });
  check('week mode is saved', q.mode === 'week');
  // Within one week, a room is with the same person every day its holder is in.
  const byWeek = {};
  q.out.forEach((x) => { (byWeek[x.week] = byWeek[x.week] || []).push(x); });
  let drift = 0, mondayMoved = 0, mondayOk = true;
  Object.values(byWeek).forEach((ds) => {
    const holder = {};
    ds.filter((x) => x.dow !== 1).forEach((x) => Object.entries(x.o).forEach(([u, p]) => {
      if (holder[u] === undefined) holder[u] = p; else if (holder[u] !== p) drift += 1;
    }));
    ds.filter((x) => x.dow === 1).forEach((x) => Object.entries(x.o).forEach(([u, p]) => {
      if (p === 'p4') mondayOk = false;                       // Dahir is off on Mondays
      if (holder[u] && holder[u] !== p && holder[u] !== 'p4') mondayMoved += 1;   // only Dahir's may move
    }));
  });
  check('a room keeps the same person all week', drift === 0, drift + ' changes within a week');
  check('somebody off for a day has nothing that day', mondayOk);
  check('…and only their rooms move that day', mondayMoved === 0, mondayMoved + ' other rooms moved on Monday');
  const weeks = Object.keys(byWeek).sort();
  const full = weeks.filter((w) => byWeek[w].some((x) => Object.keys(x.o).length));
  let same = 0, compared = 0;
  if (full.length >= 2) {
    const first = (w) => { const h = {}; byWeek[w].filter((x) => x.dow !== 1).forEach((x) => Object.entries(x.o).forEach(([u, p]) => { if (!(u in h)) h[u] = p; })); return h; };
    const a = first(full[0]), b = first(full[1]);
    Object.keys(b).forEach((u) => { if (u === 'u401' || !(u in a)) return; compared += 1; if (a[u] === b[u]) same += 1; });
  }
  check('a new Saturday gives each room to somebody new', compared > 0 && same === 0, same + ' of ' + compared + ' kept the same person');
  let fixedOk = true, capOk = true, levelOk = true, nobody = 0, ahmed = 0;
  const early = new Set(q.early);
  q.out.forEach((x) => {
    const load = {}, ear = {};
    Object.entries(x.o).forEach(([u, p]) => {
      if (!p) { nobody += 1; return; }
      if (p === 'p5') ahmed += 1;
      if (u === 'u401' && p !== q.usual[u] && x.dow !== 1) fixedOk = false;
      load[p] = (load[p] || 0) + 1; if (early.has(u)) ear[p] = (ear[p] || 0) + 1;
    });
    if (Object.values(ear).some((n) => n > 2)) capOk = false;
    const ls = ['p1', 'p2', 'p3', 'p4'].filter((p) => !(x.dow === 1 && p === 'p4')).map((p) => load[p] || 0);
    if (Object.keys(x.o).length && Math.max(...ls) - Math.min(...ls) > 1) levelOk = false;
  });
  check('a Fixed room stays with its regular cleaner', fixedOk);
  check('nobody has more than 2 early rooms', capOk);
  check('the rooms are spread evenly (within one)', levelOk);
  check('every room has somebody', nobody === 0, nobody + ' unassigned');
  check('"rooms by hand only" gets nothing dealt', ahmed === 0);
  check('only this week and last are stored', q.maps.length <= 2, q.maps.join(','));
  check('switching back to every day works', q.backToDaily);
  check('no console errors', errs.length === 0, errs.join(' | '));

  const failed = results.filter((r) => !r[1]).length;
  console.log((results.length - failed) + ' passed, ' + failed + ' failed');
  await browser.close(); s.close();
  process.exit(failed ? 1 : 0);
})();
