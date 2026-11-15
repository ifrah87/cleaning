/**
 * EASY TO USE: SOMEBODY LEAVES IN ONE SHEET, A ROOM IS ADDED IN ONE FORM.
 *
 * Ifrah, 2026-11-15: "shuffle the rooms daily … so people are never doing the same rooms
 * unless I have fixed them". With the switch on, each day ahead is dealt fresh: nobody
 * repeats a room from the day before, a Fixed room stays with its cleaner, a hand move
 * stays put, the early cap holds and the load stays level. Off puts the pins back.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/left-and-add-room.js
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

  // SOMEBODY LEAVES. Amina (p1) keeps 101, 201 (early) and 301 (early): the sheet picks
  // somebody for each without breaking the early cap, and one button finishes the job.
  const left = await page.evaluate(() => {
    const t = workToday();
    state.areas = [{ id: 'mosque', label: 'Mosque', kind: 'interior', assignedTo: 'p1' }];
    openLeaving('p1');
    const picks = { ..._leaving.picks };
    const early = (pid) => state.servicedUnits.filter((u) => u.preferEarly && (u.usualTo === pid || Object.keys(picks).some((k) => k === u.id && picks[k] === pid))).length;
    const sheetUp = !!document.querySelector('.modal .modal-confirm');
    confirmLeaving();
    const p1 = state.staff.find((p) => p.id === 'p1');
    const stillHers = state.servicedUnits.filter((u) => u.usualTo === 'p1' || u.assignedTo === 'p1').map((u) => u.unit);
    const planned = Object.keys(state.plans).filter((d) => d >= t).some((d) => Object.values(state.plans[d]).some((j) => j.assignedTo === 'p1'));
    const went = Object.keys(picks).map((id) => state.servicedUnits.find((u) => u.id === id).usualTo === picks[id]);
    return { sheetUp, picks, allPicked: Object.values(picks).every(Boolean), maxEarly: Math.max(...['p2', 'p3', 'p4'].map(early)),
      isCleaner: p1.isCleaner, stillHers, planned, went: went.every(Boolean), mosque: state.areas[0].assignedTo, sheetGone: !_leaving };
  });
  check('the Left sheet opens with a pick made for every room', left.sheetUp && left.allPicked, JSON.stringify(left.picks));
  check('…which keeps everybody within 2 early rooms', left.maxEarly <= 2, 'max ' + left.maxEarly);
  check('confirming moves each room to the person picked', left.went);
  check('…and they are no longer a cleaner', left.isCleaner === false);
  check('…and nothing is in their name any more (rooms, plans, communal)', !left.stillHers.length && !left.planned && left.mosque === null, JSON.stringify(left));
  check('…and the sheet closes', left.sheetGone);

  // ADD A ROOM IN ONE FORM: 907, weekly on Thursday, early, Bashir's.
  await page.evaluate(() => { state.tab = 'rooms'; state.roomsFilter = 'office'; render(); });
  await page.waitForTimeout(400);
  const formOk = await page.evaluate(() => !!document.getElementById('newUnit'));
  check('the Rooms page has the add form', formOk);
  if (formOk) {
    await page.fill('#newUnit', '907');
    const form = page.locator('.addbox').filter({ has: page.locator('#newUnit') });
    await form.locator('button.freqpick', { hasText: await page.evaluate(() => FREQ_LABEL.weekly) }).first().click().catch(() => {});
    await form.locator('button.freqmini', { hasText: 'Thu' }).click();
    await form.locator('button.freqmini', { hasText: 'Early room' }).click();
    await form.locator('select.area-select').selectOption('p2');
    await form.locator('button.add-btn').click();
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const u = state.servicedUnits.find((x) => String(x.unit) === '907');
      if (!u) return null;
      const nextThu = (() => { let d = shiftDay(workToday(), 1); while (dowOf(d) !== 4) d = shiftDay(d, 1); return d; })();
      const j = state.plans[nextThu] && state.plans[nextThu]['unit:' + u.id];
      return { days: u.days, early: !!u.preferEarly, usual: u.usualTo, onThu: j ? j.assignedTo : 'MISSING' };
    });
    check('the new room is saved with its days, early and cleaner', r && JSON.stringify(r.days) === '[4]' && r.early && r.usual === 'p2', JSON.stringify(r));
    check('…and is already on next Thursday\'s plan with that cleaner', r && r.onThu === 'p2', JSON.stringify(r));
  }

  // THE BOARD NO LONGER PRINTS OLD TEAM LETTERS OR FLOORS.
  const lab = await page.evaluate(() => ({ a: tvTeam({ crew: 'Team A', floors: [1, 2] }), o: tvTeam({ crew: 'Outside team', floors: [3] }) }));
  check('"Team A · Floors 1, 2" is gone from under a name', lab.a === '', lab.a);
  check('a real crew name (Outside team) still shows', lab.o === 'Outside team', lab.o);
  check('no console errors', errs.length === 0, errs.join(' | '));

  const failed = results.filter((r) => !r[1]).length;
  console.log((results.length - failed) + ' passed, ' + failed + ' failed');
  await browser.close(); s.close();
  process.exit(failed ? 1 : 0);
})();
