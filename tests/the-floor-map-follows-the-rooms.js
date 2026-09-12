/**
 * THE FLOOR MAP AND THE ROOMS IT CLAIMS TO DESCRIBE.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/the-floor-map-follows-the-rooms.js
 *
 * Two things drifted apart with nothing in the app to notice it: `floors` on a person,
 * which is what the board prints under a name and what ownerOfFloor answers with, and
 * `usualTo` on a room, which is where that room goes back to every week. By 12 Sep Team
 * A owned floors 1-2 and its only pinned room was 1002 — the tenth floor — while floor
 * 7 had an owner holding none of it and floors 10 and 11 had no owner at all, so their
 * rooms landed wherever there was space each morning.
 *
 * The rebuild reads the PINS, not today's board. On a morning with four people off
 * sick, assignedTo is mostly cover: building the map from it would hand floor 4 to
 * whoever picked it up when its owner went home, and write one bad morning into the map
 * for good.
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
const PREV = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 3 : 2)); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

const APP_STATE = {
  staff: [
    // Owns floors 1-2 on the map; the only room pinned to him is on floor 10.
    { id: 'pA', name: 'Hassan Elmi', crew: 'Team A', isCleaner: true, isLeader: true, floors: [1, 2], hikPersonId: 'h1' },
    // Owns floor 3 and keeps floor 3 — the one team the map already describes.
    { id: 'pB', name: 'Mahad Hussein', crew: 'Team B', isCleaner: true, isLeader: true, floors: [3], hikPersonId: 'h2' },
    // Owns 8-9, and also keeps most of floor 7, which belongs to somebody else.
    { id: 'pC', name: 'Abdullahi Abdi', crew: 'Team C', isCleaner: true, isLeader: true, floors: [8, 9], hikPersonId: 'h3' },
    // Owns floor 7 and keeps not one room on it.
    { id: 'pF', name: 'Mahamed Nur', crew: 'Team F', isCleaner: true, isLeader: true, floors: [7], hikPersonId: 'h4' },
    // On the board today covering, and pinned to nothing at all.
    { id: 'pH', name: 'Abukar Osman', crew: 'Team H', isCleaner: true, isLeader: true, floors: [], hikPersonId: 'h5' },
  ],
  servicedUnits: [
    { id: 'u1002', unit: '1002', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pA', assignedTo: 'pA' },
    { id: 'u301', unit: '301', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pB', assignedTo: 'pB' },
    { id: 'u302', unit: '302', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pB', assignedTo: 'pB' },
    { id: 'u702', unit: '702', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pB', assignedTo: 'pB' },
    { id: 'u704', unit: '704', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pC', assignedTo: 'pC' },
    { id: 'u705', unit: '705', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pC', assignedTo: 'pC' },
    { id: 'u803', unit: '803', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pC', assignedTo: 'pC' },
    // THE ROOM THAT MUST NOT DECIDE ANYTHING. Pinned to Team C, but handed to Abukar
    // this morning because C is short. Rebuilding from the board would give him floor 9.
    { id: 'u903', unit: '903', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pC', assignedTo: 'pH' },
    // A paused room is not on the rota and must not weigh a floor either.
    { id: 'u601', unit: '601', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pH', assignedTo: null, paused: true },
  ],
  areas: [], completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  autoAssign: false, autoBalance: false, autoConfirm: true,
  rollCallTypes: ['office', 'building'],
};
const EVENTS = APP_STATE.staff.map((p, i) => ({ person_name: p.name, person_code: String(i + 1), event_time: WORK_TODAY + ' 06:0' + i + ':00' }));

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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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

  console.log('\n\x1b[1mThe floor map follows the rooms\x1b[0m');

  const plan = await page.evaluate(() => floorOwnerProposal().map((r) => ({
    floor: r.floor, now: r.now ? r.now.id : null, next: r.next ? r.next.id : null, rooms: r.rooms,
  })));
  const at = (f) => plan.find((r) => r.floor === f);
  const dump = JSON.stringify(plan);

  check('floor 3 stays where it is, because the map already describes it',
    at(3).now === 'pB' && at(3).next === 'pB', dump);
  check('floor 7 goes to the team that actually keeps it',
    at(7).now === 'pF' && at(7).next === 'pC', dump);
  check('floor 10 gets an owner for the first time',
    at(10).now === null && at(10).next === 'pA', dump);
  check('floors nobody keeps a room on are left to nobody',
    at(5).next === null && at(11).next === null, dump);

  // The whole reason it reads usualTo: 903 is pinned to C and being walked by H today.
  check('a room being covered this morning does not hand over its floor',
    at(9).next === 'pC', dump);
  // ...and a paused room does not vote either.
  check('a paused room does not give anybody a floor',
    at(6).next === null, dump);

  const after = await page.evaluate(() => {
    // Snapshotted either side of the call itself. Comparing against the fixture would
    // be testing the app's own re-pin pass, which runs on a timer and had already moved
    // 903 back onto its usual cleaner before this line — nothing to do with the map.
    const snap = () => JSON.stringify((state.servicedUnits || []).map((u) => [u.unit, u.usualTo || null, u.assignedTo || null]));
    const before = snap();
    applyFloorProposal();
    const by = {};
    (state.staff || []).forEach((p) => { by[p.id] = { floors: p.floors || [], stamped: !!p.editedAt }; });
    return { by, moved: snap() !== before, rooms: snap() };
  });
  check('applying it gives each floor to the team that keeps it',
    JSON.stringify(after.by.pC.floors) === '[7,8,9]'
    && JSON.stringify(after.by.pA.floors) === '[10]'
    && JSON.stringify(after.by.pB.floors) === '[3]',
    JSON.stringify(after.by));
  check('...and takes floors off the team that kept none of them',
    JSON.stringify(after.by.pF.floors) === '[]', JSON.stringify(after.by));
  check('...stamping everybody it touched, so a merge cannot undo it',
    after.by.pA.stamped && after.by.pC.stamped && after.by.pF.stamped, JSON.stringify(after.by));
  check('...and moves NO rooms at all — only the floors printed against a name',
    after.moved === false, after.rooms);

  // Run twice: a map that has just been rebuilt has nothing left to say.
  const settled = await page.evaluate(() => floorOwnerProposal()
    .filter((r) => String((r.now || {}).id || '') !== String((r.next || {}).id || '')).length);
  check('a second rebuild changes nothing', settled === 0, 'drift = ' + settled);

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
