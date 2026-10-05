/**
 * TWO DAYS RUNNING THAT SOMEBODY CHOSE.
 *
 * The every-other-day rooms were set by hand on 2026-09-29 to Sat/Mon/Wed/Thu and
 * Sat/Sun/Tue/Thu, and the customers were given that timetable. The "not two days
 * running" rule then dropped every Sunday: cleaned on the Saturday, too soon. A pair of
 * days somebody typed stands; a set the app laid out itself still gets the gap.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/a-chosen-day-pair-stands.js
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

  const q = await page.evaluate(([SAT, SUN, MON, TUE]) => {
    const mk = (spec) => Object.assign({ id: 'q' + spec.unit, type: 'office', freq: 'eod' }, spec);
    const B = [0, 2, 4, 6], A = [1, 3, 4, 6];
    const hand = mk({ unit: '704', days: B, daysAuto: false });
    const auto = mk({ unit: '803', days: B, daysAuto: true });
    const handA = mk({ unit: '702', days: A, daysAuto: false });
    return {
      handSun: dueOnDayFrom(hand, SUN, SAT), handMon: dueOnDayFrom(hand, MON, SUN),
      handTue: dueOnDayFrom(hand, TUE, SUN), handNext: nextDueFrom(hand, SAT),
      autoSun: dueOnDayFrom(auto, SUN, SAT),
      handASun: dueOnDayFrom(handA, SUN, SAT), handAMon: dueOnDayFrom(handA, MON, SAT),
      today: dueOnDayFrom(hand, SUN, SUN),
      // Saturday missed, carried, cleaned Sunday (not one of A's days): Monday still stands.
      catchUpMon: dueOnDayFrom(handA, MON, SUN), catchUpNext: nextDueFrom(handA, SUN),
      autoCatchUpMon: dueOnDayFrom(mk({ unit: '802', days: A, daysAuto: true }), MON, SUN),
    };
  }, [SAT, SUN, MON, shift(SAT, 3)]);

  check('a room set by hand to Sat/Sun/Tue/Thu, cleaned Saturday, is due Sunday', q.handSun === true);
  check('…its card says Sunday too', q.handNext === SUN, 'next due reads ' + q.handNext);
  check('…cleaned Sunday, it is not due Monday', q.handMon === false);
  check('…and is back on Tuesday', q.handTue === true);
  check('the same set laid out by the app still skips the Sunday', q.autoSun === false);
  check('a Sat/Mon/Wed/Thu room cleaned Saturday is not due Sunday', q.handASun === false);
  check('…and is due Monday', q.handAMon === true);
  check('a room already cleaned today is not due again today', q.today === false);
  check('a Sat/Mon/Wed/Thu room caught up on Sunday is still due Monday', q.catchUpMon === true);
  check('…its card says Monday too', q.catchUpNext === MON, 'next due reads ' + q.catchUpNext);
  check('the same set laid out by the app still takes the gap', q.autoCatchUpMon === false);
  check('no console errors', errs.length === 0, errs.join(' | '));

  const failed = results.filter((r) => !r[1]).length;
  console.log((results.length - failed) + ' passed, ' + failed + ' failed');
  await browser.close(); s.close();
  process.exit(failed ? 1 : 0);
})();
