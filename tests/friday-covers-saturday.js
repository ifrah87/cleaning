/**
 * FRIDAY IS WORKED IN ADVANCE OF SATURDAY.
 *
 * The rooms that run every day are cleaned on the Friday FOR the Saturday, so a
 * Friday clean has to carry them to Sunday. 404 was cleaned on the Friday and put
 * straight back up on the Saturday morning — the app asking for a room that had just
 * been done in advance of that very day.
 *
 * Every-other-day rooms are NOT part of this: they run on their own cycle and a
 * Friday clean already lands them on Sunday by itself, which is where 204 belongs.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/friday-covers-saturday.js
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';
const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
// THE WORK DAY, NOT THE CALENDAR DAY — the app's day turns over at 3am.
const WORK_TODAY = (() => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); return key(d); })();
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); return key(d); })();

// A Friday comfortably in the future, so every date the schedule is questioned about
// is on the same side of "today" whatever day this test is run on. The carry-forward
// for outstanding work only applies up to today, and mixing the two sides of that
// line is how a schedule test comes out differently on a Tuesday.
const FRI = (() => { const d = new Date(WORK_TODAY + 'T12:00:00'); d.setDate(d.getDate() + 8); while (d.getDay() !== 5) d.setDate(d.getDate() + 1); return key(d); })();
const shift = (day, n) => { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() + n); return key(d); };
const THU = shift(FRI, -1), SAT = shift(FRI, 1), SUN = shift(FRI, 2), MON = shift(FRI, 3);

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1e3) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

const U = (n, extra) => Object.assign({ id: 'u' + n, unit: String(n), type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: null }, extra || {});
const APP_STATE = {
  staff: [{ id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [] }],
  teams: [{ name: 'Team A', color: '#0284c7', floors: [] }],
  servicedUnits: [
    U(404),                                            // daily — the room this is about
    U(406),                                            // the spare, for the extra-clean case
    U(204, { freq: 'eod' }),                           // every other day, its own cycle
    U(203, { freq: 'eod', days: [6, 1, 3, 5] }),       // pinned Sat/Mon/Wed/Fri
    U(207, { freq: 'daily', days: [0, 1, 2, 3, 4, 5, 6] }),  // pinned to all seven = daily
  ],
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

  console.log('\n\x1b[1mReckoning from Friday ' + FRI + '  (Sat ' + SAT + ', Sun ' + SUN + ')\x1b[0m');

  const q = await page.evaluate(([FRI, THU, SAT, SUN, MON]) => {
    const by = (n) => (state.servicedUnits || []).find((u) => u.unit === String(n));
    const ask = (n, base) => {
      const u = by(n);
      return { sat: dueOnDayFrom(u, SAT, base), sun: dueOnDayFrom(u, SUN, base),
               mon: dueOnDayFrom(u, MON, base), next: nextDueFrom(u, base) };
    };
    return {
      dailyFri: ask(404, FRI),      // cleaned on the Friday, in advance of the Saturday
      dailyThu: ask(404, THU),      // Friday missed — nothing was done in advance
      eodFri: ask(204, FRI),        // every other day, on its own cycle
      pinnedFri: ask(203, FRI),     // pinned Sat/Mon/Wed/Fri
      allSevenFri: ask(207, FRI),   // pinned to all seven days = runs every day
      dowFri: new Date(FRI + 'T00:00:00').getDay(),
    };
  }, [FRI, THU, SAT, SUN, MON]);

  check('the Friday date this test reckons from really is a Friday', q.dowFri === 5, 'got day ' + q.dowFri);

  // 404, the room that started this.
  check('a daily room cleaned on the Friday is NOT due the Saturday', q.dailyFri.sat === false);
  check('…it comes back on the Sunday', q.dailyFri.sun === true);
  check('…and the card says Sunday too, so the board and the room agree',
    q.dailyFri.next === SUN, 'next due reads ' + q.dailyFri.next);

  // A Friday that was missed is not a Friday that was worked.
  check('a daily room NOT cleaned on the Friday is still due the Saturday', q.dailyThu.sat === true,
    'cleaned ' + THU + ' — nothing was done in advance, so Saturday still stands');

  // 204 and the rest of the every-other-day rota are untouched.
  check('an every-other-day room cleaned Friday is not due Saturday', q.eodFri.sat === false);
  check('…it is due Sunday, off its own cycle, not off this rule', q.eodFri.sun === true);
  check('…and its next-due still reads Sunday', q.eodFri.next === SUN, 'next due reads ' + q.eodFri.next);
  check('a pinned Sat/Mon/Wed/Fri room cleaned Friday skips only the Saturday',
    q.pinnedFri.sat === false && q.pinnedFri.mon === true,
    'Sat ' + q.pinnedFri.sat + ', Mon ' + q.pinnedFri.mon);

  // Pinned to all seven days is another way of saying daily.
  check('a room pinned to all seven days is treated the same way', q.allSevenFri.sat === false && q.allSevenFri.sun === true,
    'Sat ' + q.allSevenFri.sat + ', Sun ' + q.allSevenFri.sun);

  // An extra clean the office asked for on a named day is a decision, not a schedule.
  const extra = await page.evaluate(([FRI, SAT]) => {
    const u = (state.servicedUnits || []).find((x) => x.unit === '406');
    u.alsoCleanOn = SAT;
    return dueOnDayFrom(u, SAT, FRI);
  }, [FRI, SAT]);
  check('an extra clean asked for on the Saturday still outranks this', extra === true);

  // The whole point: the days ahead have to come out the same way the predicate does,
  // or the plan and the roll call say different things about the same morning.
  const proj = await page.evaluate(() => {
    const walk = projectDueDays(10);
    const bad = [];
    walk.forEach((d, i) => {
      if (new Date(d.day + 'T00:00:00').getDay() !== 5) return;      // Fridays only
      const nextDay = walk[i + 1];
      if (!nextDay) return;
      const onFri = new Set(d.due.map((u) => u.id));
      nextDay.due.forEach((u) => {
        const everyDay = (u.days && u.days.length === 7) || (!(u.days || []).length && (u.freq || 'daily') === 'daily');
        if (!everyDay || !onFri.has(u.id)) return;
        // TODAY IS THE ONE DAY THE WALK DOES NOT ASSUME. Every day after it is walked as
        // though its work got done, so a Friday clean there covers the Saturday. Today
        // goes by the ticks instead, and a room nobody has cleaned is rightly still due
        // tomorrow — that is the whole of "everything is on tomorrow's board except what
        // was marked cleaned", and asserting otherwise would demand the old fiction back.
        if (i === 0 && !cleanedToday(u)) return;
        bad.push(u.unit + ' on ' + d.day + ' and again on ' + nextDay.day);
      });
    });
    return { bad, days: walk.map((d) => d.day + ':' + d.due.length) };
  });
  console.log('  the days ahead : ' + proj.days.join('  '));
  check('no daily room is projected onto a Friday and the Saturday after it',
    proj.bad.length === 0, proj.bad.join('; '));

  // THE OTHER HALF OF IT, AND THE ONE THE OFFICE ASKED FOR IN THOSE WORDS: everything
  // is on tomorrow's board except what was marked cleaned. A room due today that nobody
  // ticked has not been done, and must not be written off as done when tomorrow is built.
  const notTicked = await page.evaluate(() => {
    const tom = shiftDay(workToday(), 1);
    const walk = projectDueDays(2);
    const onTomorrow = new Set((walk[1] || { due: [] }).due.map((u) => u.id));
    const dueTodayUnticked = (walk[0] || { due: [] }).due.filter((u) => !cleanedToday(u)
      && !(u.days || []).length && (u.freq || 'daily') === 'daily');
    return { day: tom, n: dueTodayUnticked.length,
             missing: dueTodayUnticked.filter((u) => !onTomorrow.has(u.id)).map((u) => u.unit) };
  });
  check('a daily room due today that nobody ticked is still on tomorrow\u2019s board',
    notTicked.missing.length === 0,
    notTicked.n + ' unticked, missing from ' + notTicked.day + ': ' + notTicked.missing.join(', '));

  check('no console errors', errs.length === 0, errs.slice(0, 3).join('\n         '));
  await browser.close(); s.close();
  const bad = results.filter(([, ok]) => !ok);
  console.log('\n\x1b[1m' + (results.length - bad.length) + '/' + results.length + ' passed\x1b[0m');
  if (bad.length) process.exit(1);
})();
