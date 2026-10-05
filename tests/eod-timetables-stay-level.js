/**
 * THE TWO EVERY-OTHER-DAY TIMETABLES STAY LEVEL.
 *
 * A = Sat Mon Wed Thu, B = Sat Sun Tue Thu, given to the customers 2026-09-29. Ifrah
 * wants them balanced and a rule that is always checking (2026-10-05): a new room goes
 * onto whichever keeps its floor and the building level, a lopsided floor or building
 * is levelled by the app itself with the fewest moves, and what moved is written down.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/eod-timetables-stay-level.js
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
    const A = [1, 3, 4, 6], B = [0, 2, 4, 6];
    const live = { '105': B, '203': A, '204': B, '302': B, '305': A, '401': A, '701': A, '702': A, '704': B, '705': B, '802': A, '803': B };
    state.servicedUnits = Object.keys(live).map((n) => ({ id: 'r' + n, unit: n, type: 'office', freq: 'eod', days: live[n].slice(), daysAuto: false }));
    const r = {};
    r.liveIssues = eodBalanceIssues(); r.liveMoves = eodBalanceMoves().length;
    const get = (n) => state.servicedUnits.find((u) => u.unit === n);
    addServicedUnit('402', '', 'eod', 'office');
    r.new402 = eodTimetableOf(get('402')); r.new402Hand = get('402').daysAuto;
    addServicedUnit('902', '', 'eod', 'office');
    r.new902 = eodTimetableOf(get('902'));
    addServicedUnit('903', '', 'daily', 'office');
    setUnitFreq(get('903').id, 'eod');
    r.new903 = eodTimetableOf(get('903'));
    r.afterAdds = eodBalanceIssues();
    // Lopside floor 7: everything on A.
    get('704').days = A.slice(); get('705').days = A.slice();
    r.lopIssues = eodBalanceIssues();
    const mv = eodBalanceMoves();
    r.lopMoves = mv.map((m) => m.u.unit + '>' + m.to);
    mv.forEach((m) => putOnEodTimetable(m.u, m.to));
    r.fixedIssues = eodBalanceIssues();
    r.alertGone = eodBalanceAlert() === null;
    // HANDS OFF: lopside it again and let the app level it by itself.
    r.balancedNoop = autoBalanceEod(); r.noNote = !state.lastEodBalance;
    get('204').days = A.slice(); get('302').days = A.slice(); get('105').days = A.slice();
    r.autoMoved = autoBalanceEod();
    r.autoIssues = eodBalanceIssues();
    r.autoNote = state.lastEodBalance;
    r.noteText = (eodBalanceAlert() || {}).textContent || '';
    r.secondPass = autoBalanceEod();
    get('802').days = [1, 3, 6];
    r.odd = eodBalanceIssues();
    r.alertText = (eodBalanceAlert() || {}).textContent || '';
    return r;
  });

  check('the live timetables (6 A, 6 B, floors split) raise nothing', q.liveIssues.length === 0 && q.liveMoves === 0, JSON.stringify(q.liveIssues));
  check('a new room on floor 4 (401 is A) goes onto B', q.new402 === 'B', 'got ' + q.new402);
  check('…and is fixed there like the rest', q.new402Hand === false);
  check('a new room on an empty floor evens the building (7 B → A)', q.new902 === 'A', 'got ' + q.new902);
  check('a room switched to every-other-day is put on a timetable too', q.new903 === 'B', 'got ' + q.new903);
  check('after the adds it is still level', q.afterAdds.length === 0, JSON.stringify(q.afterAdds));
  check('floor 7 all on A is flagged', q.lopIssues.some((s) => /Floor 7/.test(s)), JSON.stringify(q.lopIssues));
  check('…two rooms of it go back to B and nothing else moves', q.lopMoves.length === 2 && q.lopMoves.every((m) => /^70\d>B$/.test(m)), JSON.stringify(q.lopMoves));
  check('…and that settles it', q.fixedIssues.length === 0 && q.alertGone, JSON.stringify(q.fixedIssues));
  check('a level week is never touched by the automatic pass', q.balancedNoop === 0 && q.noNote);
  check('lopsided again, the app levels it on its own', q.autoMoved > 0 && q.autoIssues.length === 0, q.autoMoved + ' ' + JSON.stringify(q.autoIssues));
  check('…writes down what it moved', q.autoNote && q.autoNote.moves.length === q.autoMoved, JSON.stringify(q.autoNote));
  check('…and says so on the morning screen, to tell the customers', /rebalanced/.test(q.noteText) && /Tell these customers/.test(q.noteText), q.noteText);
  check('…and does not churn on the next pass', q.secondPass === 0);
  check('a room on neither timetable is flagged by number', q.odd.some((s) => /802/.test(s) && /neither/.test(s)), JSON.stringify(q.odd));
  check('…and the warning offers no move for it, only says so', /802/.test(q.alertText));
  check('no console errors', errs.filter((e) => !/airbnb-stays|ERR_FAILED/.test(e)).length === 0, errs.join(' | '));

  const failed = results.filter((r) => !r[1]).length;
  console.log((results.length - failed) + ' passed, ' + failed + ' failed');
  await browser.close(); s.close();
  process.exit(failed ? 1 : 0);
})();
