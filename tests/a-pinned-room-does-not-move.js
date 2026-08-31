/**
 * A TIED ROOM DOES NOT MOVE. ASKED OF EVERY PASS THAT COULD MOVE ONE.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/a-pinned-room-does-not-move.js
 *
 * "May the app put this room on this person?" was answered in nine places, each
 * remembering a different part of the answer. autoPlanDay knew about ties and about
 * rooms-by-hand-only; assignNewPlanJobs knew about neither; the early levelling knew
 * about neither until a Monday morning handed two tied rooms to a man deliberately kept
 * off the hand-out. So a rule fixed in one place stayed broken in the others, and every
 * few days a room came off the person it was tied to by whichever pass had not been told.
 *
 * There is one function now — mayGiveRoomTo — and this asks every pass, one at a time,
 * with the board arranged to tempt each of them: the tied room's owner is carrying far
 * too much, somebody else is carrying nothing, and that somebody is both a leader and
 * marked rooms-by-hand-only. Every levelling pass in the app exists to fix exactly that
 * shape. None of them may touch the tied room, and none of them may give anything to the
 * person who is off the hand-out.
 *
 * SAFETY: never touches the live Supabase project; every request is answered locally.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';
const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const WORK_TODAY = (() => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); return key(d); })();
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); while (d.getDay() === 5) d.setDate(d.getDate() - 1); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

// p1 carries everything, including the tied room. p2 is a leader who is IN and holding
// nothing — the person every levelling pass wants to give work to. p3 is in and holding
// nothing too, but is "rooms by hand only", so nothing may reach them automatically.
const R = (id, unit, who, tied, early) => ({
  id, unit, type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE,
  preferEarly: !!early, usualTo: tied ? who : null, assignedTo: who,
});
const APP_STATE = {
  staff: [
    { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [4], hikPersonId: 'h1' },
    { id: 'p2', name: 'Hodan Omar', crew: 'Team B', isCleaner: true, isLeader: true, floors: [3], hikPersonId: 'h2' },
    { id: 'p3', name: 'Sofia Reyes', crew: 'Team C', isCleaner: true, isLeader: true, floors: [2], hikPersonId: 'h3', noAuto: true },
  ],
  servicedUnits: [
    R('su401', '401', 'p1', true, true),     // TIED to p1, and an early room
    R('su402', '402', 'p1', true, false),    // TIED to p1, ordinary
    R('su403', '403', 'p1', false, true),    // loose, early    — fair game
    R('su404', '404', 'p1', false, false),   // loose, ordinary — fair game
    R('su405', '405', 'p1', false, false),   // loose, ordinary — fair game
  ],
  areas: [], completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  autoAssign: false, autoBalance: true,
};
const EVENTS = [
  { person_name: 'Amina Yusuf', person_code: '1', event_time: WORK_TODAY + ' 06:30:00' },
  { person_name: 'Hodan Omar', person_code: '2', event_time: WORK_TODAY + ' 06:35:00' },
  { person_name: 'Sofia Reyes', person_code: '3', event_time: WORK_TODAY + ' 06:40:00' },
];

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
        const row = { data: APP_STATE, updated_at: '2026-08-31T06:00:00.000Z' };
        return json(single ? row : [row]);
      }
      return json([{ updated_at: new Date().toISOString() }], 201);
    }
    if (url.includes('/rest/v1/hik_events')) return json(m === 'GET' ? EVENTS : [{}]);
    return json([]);
  });
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.header', { timeout: 20000 });
  await page.waitForTimeout(3000);

  console.log('\n\x1b[1mA tied room does not move, whichever pass is asked\x1b[0m');

  // Every pass is asked from the same starting shape, so a pass cannot pass by accident
  // because an earlier one already levelled the board.
  const run = (call) => page.evaluate((src) => {
    // Put the board back to the shape that tempts a levelling pass: p1 holds all five,
    // two of them tied; p2 and p3 hold nothing; the once-a-day stamps are cleared so the
    // passes that run once will actually run.
    const put = { su401: 'p1', su402: 'p1', su403: 'p1', su404: 'p1', su405: 'p1' };
    (state.servicedUnits || []).forEach((u) => {
      u.assignedTo = put[u.id] || null;
      delete u.autoDealtOn;
      delete (state.assignConfirmed || {})[u.id];
    });
    ['earlyEvenedOn', 'eodLevelledOn', 'autoLevelledOn', 'lastAutoLevel', 'rebalanceOn',
     'autoAssignedOn', 'autoAssignedFor', 'lastEarlyEven'].forEach((k) => { delete state[k]; });
    let threw = null;
    try { eval(src); } catch (e) { threw = String(e && e.message || e); }
    const nm = {}; (state.staff || []).forEach((p) => { nm[p.id] = p.name; });
    const where = {};
    (state.servicedUnits || []).forEach((u) => { where[u.unit] = nm[u.assignedTo] || null; });
    // ...and what the day's PLAN says, since several of these passes write there instead.
    const plan = (state.plans || {})[workToday()] || {};
    const planWhere = {};
    Object.values(plan).forEach((j) => {
      if (j.kind !== 'unit') return;
      const u = (state.servicedUnits || []).find((x) => x.id === j.refId);
      if (u) planWhere[u.unit] = nm[j.assignedTo] || null;
    });
    return { where, planWhere, threw };
  }, call);

  const tiedHeld = (r) => r.where['401'] === 'Amina Yusuf' && r.where['402'] === 'Amina Yusuf';
  const tiedOnPlan = (r) => ['401', '402'].every((n) => !(n in r.planWhere) || r.planWhere[n] === 'Amina Yusuf');
  const handOnly = (r) => !Object.values(r.where).includes('Sofia Reyes')
    && !Object.values(r.planWhere).includes('Sofia Reyes');

  const PASSES = [
    ['the morning hand-out', 'autoAssignRooms(null, null, null, true)'],
    ['the round levelling', 'rebalanceRoundIfLopsided()'],
    ['rebalanceNamedRooms directly', 'rebalanceNamedRooms(todaysRoomList(), new Set(["p1","p2","p3"]))'],
    ['the early-round levelling', 'evenOutEarlyRooms()'],
    ['the day being laid out', 'autoPlanDay(workToday())'],
    ['the day being topped up', 'resyncPlanDay(workToday(), true)'],
    ['the week levelling', 'autoLevelIfLopsided()'],
    ['the every-other-day spread', 'levelEodPlan()'],
    ['the morning carry', 'applyPlannedAssignments()'],
    ['the stale-name sweep', 'clearStaleHandouts()'],
  ];

  for (const [name, call] of PASSES) {
    const r = await run(call);
    check(`${name} leaves the tied rooms with their own person`,
      !r.threw && tiedHeld(r) && tiedOnPlan(r),
      r.threw ? 'threw: ' + r.threw : JSON.stringify({ board: r.where, plan: r.planWhere }));
    check(`${name} gives nothing to the one marked hand-only`,
      !r.threw && handOnly(r),
      r.threw ? 'threw: ' + r.threw : JSON.stringify({ board: r.where, plan: r.planWhere }));
  }

  // The rule itself, asked directly — the refusals it exists for.
  const rule = await page.evaluate(() => {
    const u401 = state.servicedUnits.find((x) => x.unit === '401');   // tied to p1
    const u403 = state.servicedUnits.find((x) => x.unit === '403');   // loose
    state.removedStaff = { p9: '2026-08-30' };
    state.staff.push({ id: 'p9', name: 'Gone Person', crew: 'Team D', isCleaner: true, isLeader: true });
    state.staff.push({ id: 'p8', name: 'Not A Cleaner', crew: 'Team D', isCleaner: false, isLeader: true });
    const r = {
      tiedElsewhere: mayGiveRoomTo(u401, 'p2'),
      tiedToThem: mayGiveRoomTo(u401, 'p1'),
      handOnly: mayGiveRoomTo(u403, 'p3'),
      archived: mayGiveRoomTo(u403, 'p9'),
      notACleaner: mayGiveRoomTo(u403, 'p8'),
      notOnRoster: mayGiveRoomTo(u403, 'pNOBODY'),
      ordinary: mayGiveRoomTo(u403, 'p2'),
    };
    state.staff = state.staff.filter((p) => p.id !== 'p9' && p.id !== 'p8');
    delete state.removedStaff;
    return r;
  });
  check('the rule refuses a room tied to somebody else', rule.tiedElsewhere === false, JSON.stringify(rule));
  check('...but allows it to its own person', rule.tiedToThem === true, JSON.stringify(rule));
  check('the rule refuses somebody marked rooms-by-hand-only', rule.handOnly === false, JSON.stringify(rule));
  check('the rule refuses somebody archived', rule.archived === false, JSON.stringify(rule));
  check('the rule refuses somebody who is not a cleaner', rule.notACleaner === false, JSON.stringify(rule));
  check('the rule refuses a name not on the roster', rule.notOnRoster === false, JSON.stringify(rule));
  check('and allows an ordinary loose room to an ordinary cleaner', rule.ordinary === true, JSON.stringify(rule));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
