/**
 * A ROOM CAN BE TAKEN OFF TODAY FROM THE BOARD ITSELF.
 *
 * Ifrah, 2026-11-04: "why can't I delete a room from the board". The only remove was on
 * Plan a Day. Hold a room on the board (right-click with a mouse) and it comes off today.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/board-take-room-off.js
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

  await page.evaluate(() => {
    const t = workToday(), dow = dowOf(t), y = shiftDay(t, -1);
    state.attendance = { p1: 'present' };
    ['704', '705', '706', '707'].forEach((n) => {
      const u = { id: 'u' + n, unit: n, type: 'office', freq: 'daily', daysAuto: false, days: [0, 1, 2, 3, 4, 5, 6], lastCleaned: y, assignedTo: 'p1' };
      state.servicedUnits.push(u);
      getPlan(t)['unit:' + u.id] = { kind: 'unit', refId: u.id, label: 'Unit ' + n, assignedTo: 'p1' };
    });
    state.tab = 'board'; render();
  });
  const chip = (n) => page.locator('.bd-job', { hasText: n }).first();
  const onBoard = (n) => page.locator('.bd-job', { hasText: n }).count().then((c) => c > 0);
  const ticked = (id) => page.evaluate((x) => cleanedToday(state.servicedUnits.find((u) => u.id === x)), id);
  const hold = async (n, ms) => {
    await chip(n).locator('.bd-lbl').scrollIntoViewIfNeeded();
    const b = await chip(n).locator('.bd-lbl').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down(); await page.waitForTimeout(ms); await page.mouse.up();
    await page.waitForTimeout(150);
  };
  const dialog = () => page.getByText('off today?').count().then((c) => c > 0);

  check('the room is on the board to begin with', await onBoard('704'));

  await hold('704', 800);
  check('holding a room asks to take it off', await dialog());
  check('holding does not tick it', !(await ticked('u704')));
  await page.getByRole('button', { name: 'Take it off' }).click();
  await page.waitForTimeout(200);
  check('it is gone from the board', !(await onBoard('704')));
  check('the others stay', (await onBoard('705')) && (await onBoard('706')));
  const after = await page.evaluate(() => {
    const u = state.servicedUnits.find((x) => x.id === 'u704');
    return { skip: skippedToday(u), other: state.servicedUnits.find((x) => x.id === 'u705').assignedTo };
  });
  check('it is skipped for today, and rooms round it have not moved', after.skip && after.other === 'p1');

  await chip('705').locator('.bd-lbl').click({ button: 'right' });
  await page.waitForTimeout(150);
  check('right-click asks too', await dialog());
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(150);
  check('Cancel leaves it on the board, unticked', (await onBoard('705')) && !(await ticked('u705')));

  await chip('705').locator('.bd-lbl').click();
  await page.waitForTimeout(200);
  check('a plain tap still ticks a room', await ticked('u705'));

  await hold('706', 200);
  check('a short press is a tap: no question', !(await dialog()));
  check('and it ticks', await ticked('u706'));

  await hold('705', 800);
  check('a ticked room is not offered for removal', !(await dialog()) && (await onBoard('705')));

  const ahead = await page.evaluate(() => {
    const d = shiftDay(workToday(), 1), plan = getPlan(d);
    [['l1', '101', 'preferLate'], ['a1', '102', null], ['e1', '901', 'preferEarly']].forEach(([id, n, slot]) => {
      const u = { id, unit: n, type: 'office', freq: 'daily', days: null, assignedTo: 'p1' };
      if (slot) u[slot] = true;
      state.servicedUnits.push(u);
      plan['unit:' + id] = { kind: 'unit', refId: id, label: 'Unit ' + n, assignedTo: 'p1' };
    });
    const col = tvColumnsForDay(d).find((c) => !c.none);
    return col.jobs.map((j) => String(j.label).replace('Unit ', '')).filter((x) => ['101', '102', '901'].indexOf(x) >= 0).join();
  });
  check('tomorrow lists early rooms first, late ones last', ahead === '901,102,101', ahead);

  check('no console errors', errs.length === 0, errs.join(' | '));
  const failed = results.filter((r) => !r[1]).length;
  console.log((results.length - failed) + ' passed, ' + failed + ' failed');
  await browser.close(); s.close();
  process.exit(failed ? 1 : 0);
})();
