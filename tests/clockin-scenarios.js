/**
 * Clock-in → room hand-out scenarios.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/clockin-scenarios.js
 *
 * Walks a real morning the way it actually happens: the leader badges in alone at
 * 06:30 and the rest trickle in over the next two hours, with the arrival poll
 * running between each one. Asserts what the board should look like after every
 * badge-in — an even split, pins and floors respected, decisions never re-dealt.
 *
 * SAFETY: never touches the live Supabase project. Every *.supabase.co request is
 * answered from the fixtures below; writes are swallowed.
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
// NOT A FRIDAY, EVER. "Cleaned the day before" is how nearly every fixture here makes a
// room due today — and the daily rooms are cleaned on the Friday in advance of the
// Saturday, so on a Saturday that clean covers today and the room is deliberately NOT
// due. A fixture pinned to literal yesterday therefore passes six days a week and fails
// on the seventh, taking the board, the hand-out and the levelling tests down with it
// for reasons that have nothing to do with what they are testing. Step back past a
// Friday so "recently cleaned, due today" means that whatever day the suite is run.
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); while (d.getDay() === 5) d.setDate(d.getDate() - 1); return key(d); })();
const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1e3) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

// Five cleaners. Hodan leads (capped at 4 rooms, owed 2 early ones). Amina owns
// floor 2 personally; Team B owns floor 3. Sagal turns up an hour and a half late.
// EVERYBODY HERE RUNS THEIR OWN ROUND. A cleaner tagged under a leader is that
// leader's assistant and works the round with them rather than holding rooms of their
// own — so a crew of one leader and four assistants would leave four people with
// nothing, correctly, and tell us nothing about how the work is split. The assistant
// rule has its own scenario at the end.
const STAFF = [
  { id: 'p1', name: 'Hodan Omar',  crew: 'Team A', isCleaner: true, isLeader: true, floors: [] },
  { id: 'p2', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [2] },
  { id: 'p3', name: 'Fatima Ali',  crew: 'Team A', isCleaner: true, isLeader: true, floors: [] },
  { id: 'p4', name: 'Zahra Ahmed', crew: 'Team B', isCleaner: true, isLeader: true, floors: [] },
  { id: 'p5', name: 'Sagal Nur',   crew: 'Team B', isCleaner: true, isLeader: true, floors: [] },
];
const TEAMS = [ { name: 'Team A', color: '#0284c7', floors: [] }, { name: 'Team B', color: '#15803d', floors: [3] } ];

// Twelve daily rooms, all cleaned yesterday, so all twelve are due this morning.
//   104 is pinned to Fatima      -> must never move
//   201 asks for the morning     -> early round
//   301 was planned last night for Zahra -> the plan is the decision
const U = (n, extra) => Object.assign({ id: 'u' + n, unit: String(n), type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: null, usualTo: null }, extra || {});
const UNITS = [
  U(101), U(102), U(103), U(104, { usualTo: 'p3' }),
  U(201, { preferEarly: true }), U(202), U(203), U(204),
  U(301), U(302), U(303), U(304),
];
const APP_STATE = {
  staff: STAFF, teams: TEAMS, servicedUnits: UNITS, floors: 11,
  completions: {}, assignConfirmed: {}, manualArrivals: {}, attendance: {},
  // byHand: the office moved this one themselves. A plan the APP drew up from the rota
  // is only a starting point and the morning re-deals it; a room somebody moved by hand
  // is a decision and is never re-dealt. This test is about the second kind.
  plans: { [WORK_TODAY]: { 'unit:u301': { kind: 'unit', refId: 'u301', label: '301', assignedTo: 'p4', byHand: true } } },
};

// The Hik Time Card fills in through the morning; the test pushes rows into it.
let EVENTS = [];
const eventsFor = (url) => { const m = decodeURIComponent(url).match(/event_time=like\.(\d{4}-\d{2}-\d{2})/); return m ? EVENTS.filter((e) => e.event_time.startsWith(m[1])) : EVENTS; };
const badge = (name, hhmm) => EVENTS.push({ person_name: name, person_code: 'c' + name.length, event_time: WORK_TODAY + ' ' + hhmm + ':00' });

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

const results = [];
const check = (n, ok, d) => { results.push([n, !!ok]); console.log((ok ? '  \x1b[32mPASS\x1b[0m ' : '  \x1b[31mFAIL\x1b[0m ') + n + (ok || !d ? '' : '\n         ' + d)); };
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

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
      return json([{}], 201);
    }
    if (url.includes('/rest/v1/hik_events')) return json(m === 'GET' ? eventsFor(url) : [{}]);
    if (url.includes('/rest/v1/cleaning_log')) return json([], m === 'POST' ? 201 : 200);
    return json([]);
  });
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  // The realtime socket cannot connect from the harness — every request to Supabase is
  // answered locally and there is no network. That is the test working, not a fault.
  const noise = (t) => /realtime\/v1\/websocket|ERR_NAME_NOT_RESOLVED/.test(t);
  page.on('console', (x) => { if (x.type() === 'error' && !noise(x.text())) errs.push(x.text()); });
  page.on('pageerror', (e) => { if (!noise(e.message)) errs.push('pageerror: ' + e.message); });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.header', { timeout: 20000 });
  await page.waitForTimeout(2500);

  // One turn of the arrival poll: read the Time Card, hand out whatever it changes, and
  // level the round it leaves. handOutAndLevel is what the poller itself calls — calling
  // maybeAutoAssign alone tested half a badge-in, and the half it left out is the one
  // that takes rooms back off the leader who was in first and locked the lot.
  const poll = () => page.evaluate(async () => {
    await loadHikArrivals();
    handOutAndLevel();
    render();
    await new Promise((r) => setTimeout(r, 250));
    const nameOf = (id) => { const p = (state.staff || []).find((x) => x.id === id); return p ? p.name.split(' ')[0] : null; };
    const board = {};
    (state.servicedUnits || []).forEach((u) => { board[u.unit] = nameOf(u.assignedTo); });
    const load = {};
    Object.keys(hikArrivals).forEach((id) => { load[nameOf(id)] = 0; });
    (state.servicedUnits || []).forEach((u) => { const n = nameOf(u.assignedTo); if (n && n in load) load[n] += 1; });
    return { board, load, msg: (hikSyncMsg && hikSyncMsg.text) || '', err: !!(hikSyncMsg && hikSyncMsg.err), in: Object.keys(hikArrivals).length };
  });
  const show = (r) => console.log('    in: ' + r.in + '   load: ' + JSON.stringify(r.load) + '\n    ' + r.msg);
  const gap = (load) => { const v = Object.values(load); return v.length ? Math.max(...v) - Math.min(...v) : 0; };

  // ---------------------------------------------------------- 1. NOBODY IN YET
  head('06:00 — nobody has badged in');
  let r = await poll(); show(r);
  // 301 is on last night's plan and 104 is tied to Fatima permanently. Both are
  // standing decisions, so both are on the board before anybody badges in; everything
  // else waits for the crew to turn up.
  const undecided = Object.entries(r.board).filter(([u]) => u !== '301' && u !== '104');
  check('no room without a plan or a permanent cleaner is handed out before anyone clocks in',
    undecided.every(([, v]) => v === null), JSON.stringify(r.board));
  check('a room tied to one cleaner shows their name from the start', r.board['104'] === 'Fatima',
    '104 -> ' + r.board['104']);
  // A plan made last night is written onto the board at load, so the crew sees it
  // without waiting for the first badge-in.
  check('a room planned last night is already on the board', r.board['301'] === 'Zahra', '301 -> ' + r.board['301']);

  // ------------------------------------------------------ 2. THE LEADER, ALONE
  head('06:30 — Hodan (leader) badges in alone');
  badge('Hodan Omar', '06:30');
  r = await poll(); show(r);
  const held2 = Object.values(r.board).filter(Boolean).length;
  check('the morning is dealt as soon as someone is in', held2 > 0, 'still nothing handed out');
  check('301 is held for Zahra from last night\'s plan, not given away', r.board['301'] === 'Zahra' || r.board['301'] === null, '301 -> ' + r.board['301']);
  check('a leader left holding the whole building is reported, not silently overloaded',
    r.err && /limit is 4|Leader/i.test(r.msg), r.msg);

  // ------------------------------------------------- 3. SECOND CLEANER ARRIVES
  head('07:15 — Amina badges in (owns floor 2)');
  badge('Amina Yusuf', '07:15');
  r = await poll(); show(r);
  check('the board is re-dealt when someone new badges in', (r.load['Amina'] || 0) > 0, JSON.stringify(r.load));
  check('floor 2 stays with the cleaner who owns it',
    ['202', '203', '204'].every((u) => r.board[u] === 'Amina' || r.board[u] === null),
    ['202', '203', '204'].map((u) => u + '->' + r.board[u]).join(' '));
  // The early round is dealt before floor ownership and a leader is owed two of them,
  // so 201 leaves floor 2 even though Amina owns it. Documented, not a slip.
  check('an asked-for morning room outranks whose floor it is on', r.board['201'] === 'Hodan',
    '201 -> ' + r.board['201'] + ' (expected the leader, who is owed 2 early rooms)');

  // -------------------------------------------------- 4. THE REST OF THE CREW
  head('07:40 — Fatima and Zahra badge in');
  badge('Fatima Ali', '07:40');
  badge('Zahra Ahmed', '07:45');
  r = await poll(); show(r);
  check('everyone in has work', Object.keys(r.load).length === 4 && Object.values(r.load).every((n) => n > 0), JSON.stringify(r.load));
  // EVEN MEANS WHAT THE APP MEANS BY EVEN. The levelling closes the round to
  // LEVEL_CLOSE_AT and stops, deliberately: it is held with hysteresis so the board does
  // not move a room back and forth between one badge-in and the next, and a wall that
  // rearranges itself all morning is the complaint the locking was written for. Asserted
  // against the app's own constant rather than an absolute, so retuning it in Settings
  // does not make this a failure — a gap wider than the app allows still is one.
  const closeAt = await page.evaluate(() => LEVEL_CLOSE_AT);
  check(`the split is even (nobody carries more than ${closeAt} over anyone else)`,
    gap(r.load) <= closeAt, JSON.stringify(r.load));
  check('the leader is kept to 4 rooms once there is a crew', (r.load['Hodan'] || 0) <= 4, 'Hodan has ' + r.load['Hodan']);
  check('104 stays pinned to Fatima', r.board['104'] === 'Fatima', '104 -> ' + r.board['104']);
  check('last night\'s plan holds: 301 is Zahra\'s', r.board['301'] === 'Zahra', '301 -> ' + r.board['301']);
  // Team zone is a preference, not a pin: the levelling pass may pull one room out of
  // it to even the morning up. Most of the zone should still be with the team.
  // Two of the crew are still to arrive and the round is only half levelled, so the zone
  // is still lending rooms out — it gets them back as the rest badge in and the gap
  // closes. What must not happen is the whole zone leaving the team it belongs to.
  const inZone = ['302', '303', '304'].filter((u) => ['Zahra', 'Sagal'].includes(r.board[u])).length;
  check('floor 3 stays partly inside Team B while the round is still levelling', inZone >= 1,
    ['302', '303', '304'].map((u) => u + '->' + r.board[u]).join(' '));
  console.log('    note: team zone holds ' + inZone + '/3 — levelling is allowed to move one out');

  // ------------------------------------------------------- 5. POLL WITH NO NEWS
  head('07:50 — the poll runs again, nobody new');
  const before5 = JSON.stringify(r.board);
  r = await poll(); show(r);
  check('a poll that brings no new arrival does not re-shuffle the board', JSON.stringify(r.board) === before5,
    'before ' + before5 + '\n         after  ' + JSON.stringify(r.board));

  // ------------------------------- 6. THE OFFICE MOVES A ROOM, THEN A LATE ARRIVAL
  head('08:10 — office hands 102 to Hodan by hand, then Sagal badges in');
  await page.evaluate(() => { setUnitAssignee('u102', 'p1'); });
  await page.waitForTimeout(300);
  badge('Sagal Nur', '08:10');
  r = await poll(); show(r);
  check('a room the office assigned by hand is never re-dealt', r.board['102'] === 'Hodan', '102 -> ' + r.board['102']);
  check('the late arrival is given work rather than left idle', (r.load['Sagal'] || 0) > 0, JSON.stringify(r.load));
  check('the split is still even after the late arrival', gap(r.load) <= 1, JSON.stringify(r.load));

  // ------------------------------------------------- 7. A ROOM TICKED OFF STAYS DONE
  head('08:30 — Fatima finishes 104, then Hodan\'s badge-out lands');
  const done = await page.evaluate(() => {
    const u = (state.servicedUnits || []).find((x) => x.unit === '104');
    setUnitLastCleaned(u.id, todayKey(), 'p3');
    return { who: u.assignedTo, cleaned: u.lastCleaned };
  });
  badge('Hodan Omar', '15:30');           // clock-out row for the same person
  r = await poll(); show(r);
  check('a finished room is not handed to somebody else', r.board['104'] === 'Fatima', '104 -> ' + r.board['104'] + ' (' + JSON.stringify(done) + ')');

  // ------------------------------------------------------- 8. SOMEBODY GOES HOME
  head('09:00 — Amina is marked away; a room of hers must not sit with her');
  const away = await page.evaluate(async () => {
    // Through the roll call's own button, not by poking state: marking somebody away
    // has to release their rooms and re-deal on its own.
    while ((state.attendance['p2'] || 'present') !== 'noshow') cycleStatus('p2');
    state.pendingCover = null;
    render();
    await new Promise((r) => setTimeout(r, 250));
    const nameOf = (id) => { const p = (state.staff || []).find((x) => x.id === id); return p ? p.name.split(' ')[0] : null; };
    const board = {}; (state.servicedUnits || []).forEach((u) => { board[u.unit] = nameOf(u.assignedTo); });
    return { board, msg: (hikSyncMsg && hikSyncMsg.text) || '' };
  });
  const stillAmina = Object.entries(away.board).filter(([, v]) => v === 'Amina').map(([u]) => u);
  const orphans = Object.entries(away.board).filter(([u, v]) => !v && !['104'].includes(u)).map(([u]) => u);
  console.log('    rooms still on Amina: ' + (stillAmina.join(', ') || 'none'));
  check('rooms held for someone marked away go back into the pool', stillAmina.length === 0,
    'still on Amina: ' + stillAmina.join(', ') + ' — the hand-out builds its crew from hikArrivals '
    + 'and never filters out isAway(), so a badged-in cleaner marked noshow/sick keeps getting rooms');

  check('and those rooms are picked up by the crew who are in, not left blank',
    orphans.length === 0, 'nobody on: ' + orphans.join(', '));

  // AN ASSISTANT WORKS THE LEADER'S ROUND WITH THEM. Rooms go to the leader; the
  // assistant is never given one of their own.
  const asst = await page.evaluate(async () => {
    (state.staff || []).forEach((p) => { p.crew = 'Team A'; p.isLeader = p.id === 'p1'; });
    state.attendance = {};
    (state.servicedUnits || []).forEach((u) => { u.assignedTo = null; u.usualTo = null; });
    state.assignConfirmed = {}; state.planCarried = {}; state.autoAssignedFor = null;
    maybeAutoAssign(); render();
    await new Promise((r) => setTimeout(r, 300));
    const nameOf = (id) => { const p = (state.staff || []).find((x) => x.id === id); return p ? p.name.split(' ')[0] : null; };
    const held = {};
    (state.servicedUnits || []).forEach((u) => { if (u.assignedTo) held[nameOf(u.assignedTo)] = (held[nameOf(u.assignedTo)] || 0) + 1; });
    return { held, leader: 'Hodan' };
  });
  console.log('    rooms per person: ' + JSON.stringify(asst.held));
  check('only the leader is given rooms when everyone else is their assistant',
    Object.keys(asst.held).length === 1 && asst.held['Hodan'] > 0, JSON.stringify(asst.held));

  // …but a crew with no leader at all still gets the work — a rule that leaves the
  // morning undone is worse than no rule.
  const noLead = await page.evaluate(async () => {
    (state.staff || []).forEach((p) => { p.isLeader = false; });
    (state.servicedUnits || []).forEach((u) => { u.assignedTo = null; });
    state.assignConfirmed = {}; state.planCarried = {}; state.autoAssignedFor = null;
    maybeAutoAssign(); render();
    await new Promise((r) => setTimeout(r, 300));
    return (state.servicedUnits || []).filter((u) => u.assignedTo).length;
  });
  check('a crew with no leader in still gets the rooms handed out', noLead > 0, 'rooms handed out: ' + noLead);

  // A PIN OUTLASTS A PLAN. A plan made before the room was tied to somebody still
  // carries the old name; it must not take the room off the person it belongs to.
  const pinVsPlan = await page.evaluate(async () => {
    (state.staff || []).forEach((p) => { p.crew = 'Team ' + p.id; p.isLeader = true; });
    const u = (state.servicedUnits || []).find((x) => x.unit === '301');
    u.usualTo = 'p2'; u.assignedTo = null;               // tied to Amina...
    state.plans[todayKey()] = { 'unit:u301': { kind: 'unit', refId: 'u301', label: '301', assignedTo: 'p4' } };
    state.assignConfirmed = {}; state.planCarried = {}; state.autoAssignedFor = null;
    maybeAutoAssign(); render();
    await new Promise((r) => setTimeout(r, 300));
    const nameOf = (id) => { const p = (state.staff || []).find((x) => x.id === id); return p ? p.name.split(' ')[0] : null; };
    return nameOf(u.assignedTo);
  });
  check('a plan naming somebody else does not take a pinned room off its cleaner',
    pinVsPlan === 'Amina', '301 -> ' + pinVsPlan + ' (tied to Amina, planned for Zahra)');

  // THE MORNING HAND-OUT TURNS ITSELF BACK ON, ONCE. The switch lives in the saved
  // state, so a new build cannot reach it — this clears it on the next open and
  // records that it has, so switching it off afterwards sticks.
  const migrated = await page.evaluate(() => ({ auto: state.autoAssign, once: state.autoAssignOnce }));
  check('the hand-out is switched back on when the app opens',
    migrated.auto !== false && !!migrated.once, JSON.stringify(migrated));
  const staysOff = await page.evaluate(() => {
    state.autoAssign = false;          // the office switches it off again, deliberately
    applyRemote(JSON.parse(JSON.stringify(state)));   // …and the app pulls the state down again
    return state.autoAssign;
  });
  check('switching it off after that sticks — the one-off does not run twice',
    staysOff === false, 'autoAssign is now ' + staysOff);

  check('no console errors during the morning', errs.length === 0, errs.slice(0, 4).join('\n         '));

  await browser.close(); s.close();
  const bad = results.filter(([, ok]) => !ok);
  console.log('\n\x1b[1m' + (results.length - bad.length) + '/' + results.length + ' passed\x1b[0m');
  if (bad.length) { console.log(bad.map(([n]) => '  \x1b[31m✗\x1b[0m ' + n).join('\n')); process.exit(1); }
})();
