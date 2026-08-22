/**
 * Early ("asked-for morning") rooms: are they dealt FIRST, and do they go to
 * whoever badged in earliest?
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/early-rooms.js
 *
 * Six rooms the customer asked for in the morning, six ordinary ones, three
 * cleaners arriving half an hour apart. Prints who ends up with the early round
 * after each badge-in. SAFETY: nothing touches the live Supabase project.
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

// Nobody is a leader here, so the leader quota can't muddy the picture.
const STAFF = [
  { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, floors: [] },
  { id: 'p2', name: 'Fatima Ali',  crew: 'Team A', isCleaner: true, floors: [] },
  { id: 'p3', name: 'Hodan Omar',  crew: 'Team A', isCleaner: true, floors: [] },
];
const TEAMS = [{ name: 'Team A', color: '#0284c7', floors: [] }];
const U = (n, extra) => Object.assign({ id: 'u' + n, unit: String(n), type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: null, usualTo: null }, extra || {});
const EARLY = ['101', '102', '103', '104', '105', '106'];
const PLAIN = ['201', '202', '203', '204', '205', '206'];
const UNITS = EARLY.map((n) => U(n, { preferEarly: true })).concat(PLAIN.map((n) => U(n)));
const APP_STATE = { staff: STAFF, teams: TEAMS, servicedUnits: UNITS, floors: 11, completions: {}, assignConfirmed: {}, manualArrivals: {}, attendance: {}, plans: {} };

let EVENTS = [];
const eventsFor = (url) => { const m = decodeURIComponent(url).match(/event_time=like\.(\d{4}-\d{2}-\d{2})/); return m ? EVENTS.filter((e) => e.event_time.startsWith(m[1])) : EVENTS; };
const badge = (name, hhmm) => EVENTS.push({ person_name: name, person_code: 'c' + name.length, event_time: WORK_TODAY + ' ' + hhmm + ':00' });

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

const CAP = 2;   // Settings → "Morning rooms per cleaner"; the app's default

// Hand the whole board back, so what follows is a genuine morning deal rather than
// the hand-out the plan already made when the app opened.
const RESET = `
  (state.servicedUnits || []).forEach((u) => { u.assignedTo = null; });
  state.assignConfirmed = {}; state.planCarried = {}; state.autoAssignedFor = null;
`;

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
    if (url.includes('/rest/v1/app_state')) { if (m === 'GET') { const single = String(req.headers()['accept'] || '').includes('pgrst.object'); return json(single ? { data: APP_STATE } : [{ data: APP_STATE }]); } return json([{}], 201); }
    if (url.includes('/rest/v1/hik_events')) return json(m === 'GET' ? eventsFor(url) : [{}]);
    if (url.includes('/rest/v1/cleaning_log')) return json([], m === 'POST' ? 201 : 200);
    return json([]);
  });
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.nav', { timeout: 20000 });
  await page.waitForTimeout(2500);

  const poll = () => page.evaluate(async () => {
    await loadHikArrivals(); maybeAutoAssign(); render();
    await new Promise((r) => setTimeout(r, 250));
    const nameOf = (id) => { const p = (state.staff || []).find((x) => x.id === id); return p ? p.name.split(' ')[0] : null; };
    const early = {}, plain = {}, earlyLoad = {}, load = {};
    Object.keys(hikArrivals).forEach((id) => { earlyLoad[nameOf(id)] = 0; load[nameOf(id)] = 0; });
    (state.servicedUnits || []).forEach((u) => {
      const n = nameOf(u.assignedTo);
      (u.preferEarly ? early : plain)[u.unit] = n;
      if (n && n in load) { load[n] += 1; if (u.preferEarly) earlyLoad[n] += 1; }
    });
    return { early, plain, earlyLoad, load, order: Object.keys(hikArrivals).map(nameOf) };
  });
  const dump = (label, r) => {
    console.log('\n\x1b[1m' + label + '\x1b[0m');
    console.log('    early rooms : ' + Object.entries(r.early).map(([u, n]) => u + '→' + (n || '—')).join('  '));
    console.log('    ordinary    : ' + Object.entries(r.plain).map(([u, n]) => u + '→' + (n || '—')).join('  '));
    console.log('    early each  : ' + JSON.stringify(r.earlyLoad) + '    total: ' + JSON.stringify(r.load));
  };

  // 06:30 — Amina, on her own
  badge('Amina Yusuf', '06:30');
  let r = await poll(); dump('06:30 — Amina badges in first, alone', r);
  // ONE PERSON IS NOT A CREW. She takes a round of CAP and the rest wait for the next
  // arrival — handing her all six is the very thing the cap exists to stop.
  check('the only cleaner in takes a round of ' + CAP + ', not the lot',
    (r.earlyLoad['Amina'] || 0) === CAP, JSON.stringify(r.earlyLoad));
  check('the early rooms she cannot take are left free, not forced on her',
    EARLY.filter((u) => !r.early[u]).length === EARLY.length - CAP, JSON.stringify(r.early));

  // 07:00 — Fatima
  badge('Fatima Ali', '07:00');
  r = await poll(); dump('07:00 — Fatima badges in (30 min later)', r);
  // With two in and a round of CAP each, four of the six morning rooms go out and the
  // other two wait for the next arrival. Both of them fill their round before either
  // picks up ordinary work — that is what "morning rooms first" means once it is capped.
  check('both of them have a full round of ' + CAP + ' morning rooms',
    Object.values(r.earlyLoad).every((n) => n === CAP), JSON.stringify(r.earlyLoad));
  check('the morning rooms they cannot take are still waiting, not given to somebody else',
    EARLY.filter((u) => !r.early[u]).length === EARLY.length - 2 * CAP, JSON.stringify(r.early));
  const amina2 = r.earlyLoad['Amina'] || 0, fatima2 = r.earlyLoad['Fatima'] || 0;
  check('neither of them is over the round of ' + CAP,
    amina2 === CAP && fatima2 === CAP, 'Amina ' + amina2 + ' vs Fatima ' + fatima2);
  console.log('    → early round split ' + amina2 + '/' + fatima2);

  // 07:30 — Hodan
  badge('Hodan Omar', '07:30');
  r = await poll(); dump('07:30 — Hodan badges in last', r);
  check('all six early rooms still have a name against them', EARLY.every((u) => !!r.early[u]), JSON.stringify(r.early));
  const el = r.earlyLoad;
  check('nobody carries more than ' + CAP + ' asked-for mornings', Math.max(...Object.values(el)) <= CAP,
    JSON.stringify(el));
  // With everybody in, the levelling pass evens the morning up rather than leaving the
  // two early birds holding all six — which is the whole point of a round.
  check('the early round is spread across the crew, not stacked on the first two in',
    Math.max(...Object.values(el)) - Math.min(...Object.values(el)) <= 1, JSON.stringify(el));

  // ------------------------------------------------- MORE EARLY ROOMS THAN THE CREW
  // Six more asked-for mornings land on the same three cleaners: 12 early rooms, a
  // round of 3 each = 9. The surplus must still be dealt, and shared out evenly.
  const flood = await page.evaluate(async (reset) => {
    (state.servicedUnits || []).forEach((u) => { u.preferEarly = true; u.preferLate = false; });
    eval(reset);
    maybeAutoAssign(); render();
    await new Promise((r) => setTimeout(r, 250));
    const nameOf = (id) => { const p = (state.staff || []).find((x) => x.id === id); return p ? p.name.split(' ')[0] : null; };
    const earlyLoad = {}, unassigned = [];
    Object.keys(hikArrivals).forEach((id) => { earlyLoad[nameOf(id)] = 0; });
    (state.servicedUnits || []).forEach((u) => {
      const n = nameOf(u.assignedTo);
      if (!n) unassigned.push(u.unit); else if (n in earlyLoad) earlyLoad[n] += 1;
    });
    return { earlyLoad, unassigned, msg: (hikSyncMsg && hikSyncMsg.text) || '' };
  }, RESET);
  console.log('\n\x1b[1mAll 12 rooms asked for in the morning, 3 cleaners, round of ' + CAP + '\x1b[0m');
  console.log('    early each  : ' + JSON.stringify(flood.earlyLoad));
  console.log('    ' + flood.msg);
  const fv = Object.values(flood.earlyLoad);
  check('nobody goes over their round however many morning rooms there are',
    Math.max(...fv) <= CAP, JSON.stringify(flood.earlyLoad));
  check('the crew take a full round each', fv.every((n) => n === CAP), JSON.stringify(flood.earlyLoad));
  check('the rest are left for the next arrivals rather than piled on somebody',
    flood.unassigned.length === 12 - fv.length * CAP,
    flood.unassigned.length + ' left: ' + flood.unassigned.join(', '));
  check('the hand-out says what it held back', /left for the next arrivals/.test(flood.msg), flood.msg);

  // A ROOM TIED TO ONE PERSON IS THEIRS. Even when it is an early room, even when the
  // person is a leader already holding a full round.
  const pinned = await page.evaluate(async (reset) => {
    (state.servicedUnits || []).forEach((u) => { u.preferEarly = u.unit === '101'; u.preferLate = false; u.usualTo = null; });
    const one = (state.servicedUnits || []).find((u) => u.unit === '101');
    one.usualTo = 'p3';                       // Hodan — the LAST person to badge in
    const lead = (state.staff || []).find((p) => p.id === 'p3');
    lead.isLeader = true;                     // and a leader, so the 4-room cap applies
    eval(reset);
    maybeAutoAssign(); render();
    await new Promise((r) => setTimeout(r, 250));
    const nameOf = (id) => { const p = (state.staff || []).find((x) => x.id === id); return p ? p.name.split(' ')[0] : null; };
    return { who: nameOf(one.assignedTo), msg: (hikSyncMsg && hikSyncMsg.text) || '' };
  }, RESET);
  check('a room tied to one cleaner goes to them even when it is an early room',
    pinned.who === 'Hodan', '101 -> ' + pinned.who + ' (tied to Hodan, who badged in last)');

  check('no console errors', errs.length === 0, errs.slice(0, 3).join('\n         '));
  await browser.close(); s.close();
  const bad = results.filter(([, ok]) => !ok);
  console.log('\n\x1b[1m' + (results.length - bad.length) + '/' + results.length + ' passed\x1b[0m');
  if (bad.length) { console.log(bad.map(([n]) => '  \x1b[31m✗\x1b[0m ' + n).join('\n')); process.exit(1); }
})();
