/**
 * A ROOM ON TODAY'S BOARD IS NOT THE SCHEDULE'S TO WITHDRAW.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/board-stays-put.js
 *
 * Monday 24 Aug: the board went up at 06:09 with 401 and 204 on it, somebody opened the
 * app at 07:24, the every-other-day levelling pass moved eight rooms onto Sun/Tue/Thu,
 * and those two disappeared off a board the crew were already working. This is that
 * morning, reduced: move a room off the days it is due on TODAY and check it is still
 * there — the new pattern is allowed to decide every day except the one being worked.
 *
 * SAFETY: never touches the live Supabase project; every request to *.supabase.co is
 * answered from the fixtures below.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';

const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const back = (n) => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); d.setDate(d.getDate() - n); return key(d); };
const THREE_DAYS_AGO = back(3);

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const APP_STATE = {
  staff: [{ id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [1, 2, 3, 4], hikPersonId: 'h1' }],
  servicedUnits: [
    // The two rooms off the 24 Aug board, with the schedule they actually had:
    // every other day, on one of the app's own two weekday sets, last cleaned three
    // days ago — so both are due this morning whatever day the test runs on.
    { id: 'su401', unit: '401', type: 'office', freq: 'eod', daysAuto: true, lastCleaned: THREE_DAYS_AGO },
    { id: 'su204', unit: '204', type: 'office', freq: 'eod', daysAuto: true, lastCleaned: THREE_DAYS_AGO },
    // Not due today — the levelling pass may move this one freely.
    { id: 'su601', unit: '601', type: 'office', freq: 'weekly', lastCleaned: back(1) },
    // No days at all, on a cycle that has it due today: the day-PINNING pass is the
    // other way a room can be dropped from a morning it was already on.
    { id: 'su305', unit: '305', type: 'office', freq: 'eod', lastCleaned: THREE_DAYS_AGO },
  ],
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  // The passes are stamped as already run today, so nothing fires behind the test's
  // back — each one is invoked directly, which is the thing under test.
  autoDaysOn: key(new Date()), eodLevelledOn: key(new Date()),
};

function serve() {
  return new Promise((r) => {
    const s = http.createServer((q, res) => {
      const f = q.url.split('?')[0] === '/' ? '/index.html' : q.url.split('?')[0];
      const p = path.join(ROOT, f);
      if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'text/plain' });
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
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
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
    return json([]);
  });
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.nav', { timeout: 20000 });
  await page.waitForTimeout(2500);

  console.log('\n\x1b[1mThe board does not change under the crew\x1b[0m');

  // Put 401 and 204 on a set that includes today, exactly as the live rooms were, and
  // 305 on no days at all. Then move them the way this morning's pass did.
  const r = await page.evaluate(() => {
    const dow = dowOf(workToday());
    const here = EOD_SETS.find((s) => s.indexOf(dow) >= 0) || [dow];
    const elsewhere = EOD_SETS.find((s) => s.indexOf(dow) < 0) || [(dow + 1) % 7];
    const byUnit = (n) => state.servicedUnits.find((u) => u.unit === n);
    const u401 = byUnit('401'), u204 = byUnit('204'), u601 = byUnit('601'), u305 = byUnit('305');
    u401.days = here.slice(); u204.days = here.slice();
    u601.days = here.slice();                       // on today's days, but cleaned yesterday
    const onBoard = () => todaysRoomList().map((u) => u.unit);
    const before = onBoard();

    // 1. the every-other-day levelling pass, moving them to the other pattern
    applyEodLevel({ moves: [{ u: u401, days: elsewhere.slice() }, { u: u204, days: elsewhere.slice() }] });
    const afterLevel = onBoard();

    // 2. the day-pinning pass, putting a room with no days onto days that exclude today
    applySuggestedDays({ proposals: [{ u: u305, days: elsewhere.slice() }] });
    const afterPin = onBoard();

    // 3. a room that was NOT on today's board must not be dragged onto it
    const u601WasDue = before.indexOf('601') >= 0;
    applyEodLevel({ moves: [{ u: u601, days: elsewhere.slice() }] });

    return {
      dow, here, elsewhere, before, afterLevel, afterPin,
      u601WasDue, u601Also: u601.alsoCleanOn || null, u601OnBoard: onBoard().indexOf('601') >= 0,
      days401: u401.days, days305: u305.days,
      also401: u401.alsoCleanOn || null, also305: u305.alsoCleanOn || null,
      day: workToday(),
    };
  });

  check('401 and 204 start on today’s board', r.before.includes('401') && r.before.includes('204'), r.before.join(', '));
  check('levelling them onto the other pattern leaves them on today’s board',
    r.afterLevel.includes('401') && r.afterLevel.includes('204'), 'after: ' + r.afterLevel.join(', '));
  check('and the new pattern is what they actually carry from now on',
    JSON.stringify(r.days401) === JSON.stringify(r.elsewhere), JSON.stringify(r.days401));
  check('today is kept as the one-off the schedule already understands', r.also401 === r.day, String(r.also401));
  check('pinning a room onto days that exclude today leaves it on today’s board',
    r.afterPin.includes('305'), 'after: ' + r.afterPin.join(', '));
  check('and it too carries the new days', JSON.stringify(r.days305) === JSON.stringify(r.elsewhere), JSON.stringify(r.days305));
  check('a room that was not due today is not dragged onto the board',
    r.u601WasDue || (!r.u601OnBoard && r.u601Also === null), `was due: ${r.u601WasDue}, on board: ${r.u601OnBoard}, extra: ${r.u601Also}`);
  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
