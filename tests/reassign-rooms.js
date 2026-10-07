/**
 * REASSIGN ROOMS: ONE SCREEN, ANY ROOMS, ANYBODY, TODAY / TOMORROW / FROM NOW ON.
 *
 * Ifrah, 2026-10-07: "I want to be able to assign the rooms more easily." Tap
 * ⇄ Reassign, pick when, tap several rooms, tap who. Today and tomorrow take anybody
 * tagged a cleaner (Ahmed, a helper); from now on stays leaders.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/reassign-rooms.js
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
    { id: 'p6', name: 'Ahmed Daahir', crew: null, isCleaner: true, isLeader: false, noAuto: true, floors: [] },
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

  const tap = async (sel, text) => {
    const ok = await page.evaluate(([sel, text]) => {
      const b = [...document.querySelectorAll(sel)].find((x) => x.textContent.replace(/\s+/g, ' ').trim().startsWith(text));
      if (b) b.click(); return !!b;
    }, [sel, text]);
    await page.waitForTimeout(250);
    return ok;
  };
  const T = await page.evaluate(() => {
    const t = workToday(), y = shiftDay(t, -1), t1 = shiftDay(t, 1);
    const job = (u, who) => ({ kind: 'unit', refId: u, label: 'Unit ' + u, assignedTo: who, auto: true });
    state.servicedUnits = [
      { id: 'r1', unit: '301', type: 'office', freq: 'daily', usualTo: 'p1', assignedTo: 'p1', lastCleaned: y },
      { id: 'r2', unit: '302', type: 'office', freq: 'daily', usualTo: 'p1', assignedTo: 'p1', lastCleaned: y },
      { id: 'r3', unit: '303', type: 'office', freq: 'daily', usualTo: 'p1', assignedTo: 'p1', lastCleaned: t },
    ];
    state.plans = {}; state.planSeeded = {};
    [t, t1].forEach((d) => { state.plans[d] = { 'unit:r1': job('r1', 'p1'), 'unit:r2': job('r2', 'p1'), 'unit:r3': job('r3', 'p1') }; state.planSeeded[d] = true; });
    setTab('board');
    return { t, t1 };
  });
  await page.waitForTimeout(300);
  const st = () => page.evaluate(([t, t1]) => {
    const g = (id) => state.servicedUnits.find((u) => u.id === id);
    return { a1: g('r1').assignedTo, a2: g('r2').assignedTo, a3: g('r3').assignedTo, u1: g('r1').usualTo, u2: g('r2').usualTo,
      p1t: state.plans[t]['unit:r2'].assignedTo, p1: state.plans[t1]['unit:r1'].assignedTo, p1h: state.plans[t1]['unit:r1'].byHand,
      p2: state.plans[t1]['unit:r2'].assignedTo, sheet: [...document.querySelectorAll('.modal-title')].some((x) => x.textContent === 'Reassign rooms'),
      msg: (document.querySelector('.modal') || {}).textContent || '' };
  }, [T.t, T.t1]);

  check('the board has a ⇄ Reassign button', await tap('button.tb-btn', '⇄ Reassign'));
  check('…which opens Reassign rooms on Today', (await st()).sheet);
  await tap('.modal button.freqmini', '301'); await tap('.modal button.freqmini', '302');
  let s1 = await st();
  check('several rooms can be picked at once', /2 picked/.test(s1.msg), s1.msg.slice(0, 200));
  check('Ahmed (an ad-hoc helper) is offered for today', /Ahmed Daahir/.test(s1.msg));
  await tap('.modal .cover-opt', 'Ahmed Daahir');
  s1 = await st();
  check('both rooms go to Ahmed today', s1.a1 === 'p6' && s1.a2 === 'p6' && s1.p1t === 'p6', JSON.stringify(s1));
  check('…their regular cleaner is unchanged', s1.u1 === 'p1' && s1.u2 === 'p1');
  check('…tomorrow is untouched', s1.p1 === 'p1');
  check('…and it says what it did', /301, 302 → Ahmed Daahir today/.test(s1.msg), s1.msg.slice(0, 200));
  await tap('.modal button.freqmini', '303'); await tap('.modal .cover-opt', 'Bashir Ali');
  s1 = await st();
  check('a room already cleaned today is left with who cleaned it', s1.a3 === 'p1' && /303 already cleaned/.test(s1.msg), s1.msg.slice(0, 200));

  await tap('.modal button.freqpick', 'Tomorrow');
  await tap('.modal button.freqmini', '301'); await tap('.modal .cover-opt', 'Bashir Ali');
  s1 = await st();
  check('Tomorrow: 301 goes to Bashir on tomorrow\'s plan, locked by hand', s1.p1 === 'p2' && s1.p1h === true, JSON.stringify(s1));
  check('…today and the regular cleaner stay as they were', s1.a1 === 'p6' && s1.u1 === 'p1');

  await tap('.modal button.freqpick', 'From now on');
  s1 = await st();
  check('From now on offers leaders only (no Ahmed, no helper)', !/Ahmed Daahir/.test(s1.msg.split('2. Tap who')[1] || '') && !/Zakaria/.test(s1.msg.split('2. Tap who')[1] || ''), s1.msg.split('2. Tap who')[1]);
  check('…and equal leaders are one choice', /Abukar Daud \/ Mahamed Abiker/.test(s1.msg));
  await tap('.modal button.freqmini', '302'); await tap('.modal .cover-opt', 'Abukar Daud / Mahamed Abiker');
  s1 = await st();
  check('From now on: 302 is Team H\'s, today and tomorrow follow', s1.u2 === 'p3' && s1.a2 === 'p3' && s1.p2 === 'p3', JSON.stringify(s1));
  await tap('.modal .modal-skip', 'Done');
  check('Done closes it', !(await st()).sheet);
  await page.evaluate(() => setTab('team')); await page.waitForTimeout(300);
  check('the Team page opens it too', await tap('button.add-btn', '⇄ Reassign several rooms') && (await st()).sheet);
  check('no console errors', errs.filter((e) => !/airbnb-stays|ERR_FAILED/.test(e)).length === 0, errs.join(' | '));

  const failed = results.filter((r) => !r[1]).length;
  console.log((results.length - failed) + ' passed, ' + failed + ' failed');
  await browser.close(); s.close();
  process.exit(failed ? 1 : 0);
})();
