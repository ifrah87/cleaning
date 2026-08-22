/**
 * Every-other-day rooms: are they spread across the week, or piled on one set of days?
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/eod-spread.js [state.json]
 *
 * With no argument it runs on a fixture that reproduces the clump. Pass a JSON file
 * holding an app_state row and it runs on that instead — READ ONLY, the result is
 * never written anywhere.
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';
const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const TODAY = key(new Date()), YESTERDAY = key(new Date(Date.now() - 864e5));
// THE WORK DAY, NOT THE CALENDAR DAY. The app's day runs from 3am, so a test started
// at half past midnight has a work day of YESTERDAY — and a room stamped "cleaned
// yesterday" by the calendar reads as cleaned today and is not due. Everything the
// fixtures date is dated from the work day.
const WORK_TODAY = (() => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); return key(d); })();
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); return key(d); })();
const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1e3) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], WEEK = [6, 0, 1, 2, 3, 4, 5];

// The clump as it actually stands: every eod room on Sat/Mon/Wed/Fri, cleaned in one
// batch yesterday, which is exactly how they all came to ask for the same set.
const SET_A = [6, 1, 3, 5];
const U = (n, extra) => Object.assign({ id: 'u' + n, unit: String(n), type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: null }, extra || {});
const FIXTURE = {
  staff: [{ id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, floors: [] }],
  teams: [{ name: 'Team A', color: '#0284c7', floors: [] }],
  servicedUnits: []
    .concat([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112].map((n) => U(n, { freq: 'eod', days: SET_A.slice() })))
    .concat([201, 202, 203, 204].map((n) => U(n))),
  floors: 11, completions: {}, assignConfirmed: {}, manualArrivals: {}, attendance: {}, plans: {},
};
const arg = process.argv[2];
let APP_STATE = FIXTURE;
if (arg) {
  const raw = JSON.parse(fs.readFileSync(arg, 'utf8'));
  APP_STATE = Array.isArray(raw) ? raw[0].data : (raw.data || raw);
  // Nobody badges in on a schedule check, and the hand-out must not run over real names.
  APP_STATE.manualArrivals = {};
}

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
  let writes = 0;
  await ctx.route(`**://${SUPA_HOST}/**`, async (route) => {
    const req = route.request(), url = req.url(), m = req.method();
    const json = (b, st = 200) => route.fulfill({ status: st, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(b) });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }, body: '' });
    if (url.includes('/auth/v1/token')) return json(SESSION);
    if (url.includes('/auth/v1/user')) return json(SESSION.user);
    if (url.includes('/rest/v1/app_state')) {
      if (m === 'GET') { const single = String(req.headers()['accept'] || '').includes('pgrst.object'); return json(single ? { data: APP_STATE } : [{ data: APP_STATE }]); }
      writes += 1;                      // swallowed — this test never writes anything back
      return json([{}], 201);
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
  await page.waitForSelector('.nav', { timeout: 20000 });
  await page.waitForTimeout(3000);

  const snap = await page.evaluate(() => {
    const eod = (state.servicedUnits || []).filter((u) => (u.freq || 'daily') === 'eod' && onRollCall(u) && !u.paused);
    const load = [0, 0, 0, 0, 0, 0, 0];
    eod.forEach((u) => { const d = fixedDays(u); if (d) d.forEach((x) => { load[x] += 1; }); });
    const patterns = {};
    eod.forEach((u) => { const k = (fixedDays(u) || []).join(','); patterns[k] = (patterns[k] || 0) + 1; });
    return { load, patterns, n: eod.length, last: state.lastEodLevel || null };
  });
  const row = (l) => WEEK.map((d) => DOW[d] + ' ' + l[d]).join('  ');
  console.log('\n\x1b[1mEvery-other-day rooms: ' + snap.n + '\x1b[0m');
  console.log('  after the app has opened : ' + row(snap.load));
  console.log('  patterns                 : ' + JSON.stringify(snap.patterns));
  if (snap.last) console.log('  levelling moved          : ' + snap.last.moves + ' rooms (worst morning ' + snap.last.from + ' → ' + snap.last.to + '): ' + snap.last.rooms.join(', '));

  // What the pass WOULD do, whatever the settings say — the automatic run is gated on
  // "Keep the week level", and on the live building that switch is off.
  const would = await page.evaluate(() => {
    const plan = levelEodPlan();
    return {
      moves: plan.moves.length,
      rooms: plan.moves.map((m) => m.u.unit),
      before: plan.before, after: plan.load,
      autoBalance: state.autoBalance, autoDays: state.autoDays, autoAssign: state.autoAssign,
      eodSpread: state.eodSpread,
    };
  });
  console.log('\n  settings on this data    : split-eod-rooms=' + (would.eodSpread === false ? 'OFF' : 'on')
    + ', keep-week-level=' + (would.autoBalance === false ? 'OFF' : 'on')
    + ', put-rooms-on-days=' + (would.autoDays === false ? 'OFF' : 'on')
    + ', hand-out-each-morning=' + (would.autoAssign === false ? 'OFF' : 'on'));
  console.log('  what the spread would do : ' + would.moves + ' rooms move (' + would.rooms.join(', ') + ')');
  console.log('    before : ' + row(would.before));
  console.log('    after  : ' + row(would.after));

  const peak = Math.max(...WEEK.filter((d) => d !== 5).map((d) => snap.load[d]));
  const low = Math.min(...WEEK.filter((d) => d !== 5).map((d) => snap.load[d]));
  // Friday is the office's own day and is meant to be empty, so it is not part of
  // "is the week level" — the app only fills the other six.
  const auto = (l) => WEEK.filter((d) => d !== 5).map((d) => l[d]);
  const wPeak = Math.max(...auto(would.after)), wLow = Math.min(...auto(would.after));
  check('the spread leaves the week level', wPeak - wLow <= Math.ceil(snap.n / 4) + 1,
    'worst ' + wPeak + ' vs lightest ' + wLow + ' — ' + row(would.after));
  check('nothing automatic is left on the day the office picks', would.after[5] === 0,
    'Friday still carries ' + would.after[5]);
  check('it takes a real bite out of the worst morning',
    Math.max(...auto(would.before)) - wPeak >= 2 || Math.max(...auto(would.before)) - Math.min(...auto(would.before)) <= 1,
    row(would.before) + '  ->  ' + row(would.after));
  if (would.eodSpread !== false) {
    check('the automatic pass ran on open and said what it moved', !!snap.last || peak - low <= 1,
      'no lastEodLevel recorded and the week is still ' + peak + '/' + low);
  } else {
    console.log('  \x1b[33mNOTE\x1b[0m  the spread is switched off on this data — Settings → "Split the every-other-day rooms"');
  }

  // Twice in a row must not churn: a room that is where it should be stays there.
  const second = await page.evaluate(() => {
    state.eodLevelledOn = null;
    const before = (state.servicedUnits || []).map((u) => u.id + ':' + ((u.days || []).join()));
    autoLevelEodDays();
    const after = (state.servicedUnits || []).map((u) => u.id + ':' + ((u.days || []).join()));
    return before.join('|') === after.join('|');
  });
  check('running it again moves nothing — it settles instead of churning', second);

  // A set somebody typed themselves is a decision.
  const handSet = await page.evaluate(() => {
    const u = (state.servicedUnits || []).filter((x) => (x.freq || 'daily') === 'eod')[0];
    if (!u) return true;
    u.days = [1, 3];                 // Mon/Wed — nothing the app would ever choose
    u.daysAuto = false;
    state.eodLevelledOn = null;
    autoLevelEodDays();
    return (u.days || []).join() === '1,3';
  });
  check('days set by hand are never re-spread', handSet);

  // FRIDAY IS THE OFFICE'S. Fewer cleaners are in, so they pick that day themselves —
  // nothing automatic may land on it.
  const fri = await page.evaluate(() => {
    const onFri = (state.servicedUnits || []).filter((u) => onRollCall(u) && !u.paused
      && (fixedDays(u) || []).indexOf(5) >= 0);
    return { units: onFri.map((u) => u.unit + (u.daysAuto === false ? ' (by hand)' : '')),
             auto: onFri.filter((u) => u.daysAuto !== false).map((u) => u.unit) };
  });
  // Only meaningful where the automatic pass is allowed to run. On data with
  // "Keep the week level" switched off the rooms are still where the office left them,
  // and the "would" figures above are what says whether the code is right.
  if (would.eodSpread !== false) {
    check('nothing the app put on days is scheduled for a Friday', fri.auto.length === 0,
      'on Friday: ' + fri.units.join(', '));
  } else {
    console.log('  \x1b[33mNOTE\x1b[0m  ' + fri.auto.length + ' rooms still on Friday — the pass that clears it is switched off here');
  }

  // Retiring a pattern must not strand the rooms still on it.
  const legacy = await page.evaluate(() => {
    const u = (state.servicedUnits || []).filter((x) => (x.freq || 'daily') === 'eod')[1];
    if (!u) return true;
    u.days = [6, 1, 3, 5];           // the old Sat/Mon/Wed/Fri pattern
    delete u.daysAuto;
    state.eodLevelledOn = null;
    autoLevelEodDays();
    return (u.days || []).indexOf(5) < 0;
  });
  if (would.eodSpread !== false) check('a room left on a retired pattern is moved off it, not stranded', legacy);

  check('no console errors', errs.length === 0, errs.slice(0, 3).join('\n         '));
  console.log('\n  (writes to Supabase intercepted and discarded: ' + writes + ')');
  await browser.close(); s.close();
  const bad = results.filter(([, ok]) => !ok);
  console.log('\n\x1b[1m' + (results.length - bad.length) + '/' + results.length + ' passed\x1b[0m');
  if (bad.length) process.exit(1);
})();
