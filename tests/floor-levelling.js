/**
 * A FLOOR HOLDS UNTIL THE ROUND IS THREE APART.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/floor-levelling.js
 *
 * Keeping a cleaner on their own floor saves a lot of walking, so a room sitting with
 * its floor's owner was frozen: levelling could not touch it. That is right until the
 * floors fall unevenly, and then it is somebody carrying five while somebody else
 * carries one, with the pass that exists to prevent exactly that unable to act.
 *
 * So a floor is a strong preference, not a promise: it opens at a gap of three or more
 * and closes again at two. The extremes go, the floors otherwise hold. A room tied to
 * a person never moves, whatever the gap.
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
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const L = (id, name, crew, floors, hik) => ({ id, name, crew, isCleaner: true, isLeader: true, floors, hikPersonId: hik });
const R = (unit, extra) => Object.assign({ id: 'su' + unit, unit, type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE }, extra || {});

// Floor 4 carries five rooms, floor 3 carries one, floor 2 carries two. Nobody is
// pinned to anybody. That is a gap of four the moment the floors are honoured.
const APP_STATE = {
  staff: [L('p1', 'Amina Yusuf', 'Team A', [4], 'h1'), L('p2', 'Hodan Omar', 'Team B', [3], 'h2'),
          L('p3', 'Sofia Reyes', 'Team C', [2], 'h3')],
  servicedUnits: [
    R('401'), R('402'), R('403'), R('404'), R('405'),
    R('301'),
    R('201'), R('202'),
  ],
  areas: [], completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  autoAssign: false, autoConfirm: true,
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

// Deal the rooms in the page, honouring floors, and report where they landed.
const deal = (pins) => (pinMap) => {
  const staffById = {}; (state.staff || []).forEach((p) => { staffById[p.id] = p; });
  state.servicedUnits.forEach((u) => { u.assignedTo = null; u.usualTo = pinMap[u.unit] || null; });
  const people = state.staff.slice();
  const inIds = new Set(people.map((p) => p.id));
  const load = {}; people.forEach((p) => { load[p.id] = 0; });
  const rooms = state.servicedUnits.slice();
  runAutoAssign(rooms, people, inIds, load, null, true);
  const byName = {};
  state.staff.forEach((p) => { byName[p.name.split(' ')[0]] = 0; });
  const where = {};
  state.servicedUnits.forEach((u) => {
    const p = staffById[u.assignedTo];
    where[u.unit] = p ? p.name.split(' ')[0] : null;
    if (p) byName[p.name.split(' ')[0]] += 1;
  });
  const onFloor = state.servicedUnits.filter((u) => {
    const owner = (state.staff || []).find((p) => (p.floors || []).includes(Number(String(u.unit).slice(0, -2))));
    return owner && u.assignedTo === owner.id;
  }).length;
  const counts = Object.values(byName);
  return { load: byName, where, onFloor, gap: Math.max(...counts) - Math.min(...counts),
           note: (state.lastAutoLevel && state.lastAutoLevel.note) || '' };
};

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

  console.log('\n\x1b[1mFive rooms against one: the floor opens\x1b[0m');
  const wide = await page.evaluate(deal(), {});
  check('the round is no longer three or more apart', wide.gap <= 2, JSON.stringify(wide.load));
  check('but it is not flattened either — floors are still worth something',
    wide.gap >= 1, JSON.stringify(wide.load));
  check('most rooms are still with the person whose floor they are on',
    wide.onFloor >= 5, wide.onFloor + '/8 on their own floor · ' + JSON.stringify(wide.where));
  check('nobody is left with nothing to do',
    Math.min(...Object.values(wide.load)) >= 1, JSON.stringify(wide.load));

  console.log('\n\x1b[1mA room tied to a person does not move, whatever the gap\x1b[0m');
  const pinned = await page.evaluate(deal(), { 405: 'p1', 404: 'p1' });
  check('both pins stayed with the person they are tied to',
    pinned.where['405'] === 'Amina' && pinned.where['404'] === 'Amina',
    '405->' + pinned.where['405'] + ' 404->' + pinned.where['404']);
  check('and the rest still evened out around them', pinned.gap <= 2, JSON.stringify(pinned.load));

  console.log('\n\x1b[1mTwo apart is left alone\x1b[0m');
  const narrow = await page.evaluate(() => {
    // Trim floor 4 to three rooms: 3 / 1 / 2 is a gap of two, under the threshold.
    state.servicedUnits = state.servicedUnits.filter((u) => !['404', '405'].includes(u.unit));
    return null;
  }).then(() => page.evaluate(deal(), {}));
  check('every room is with its own floor owner — nothing was moved',
    narrow.onFloor === 6, narrow.onFloor + '/6 on their own floor · ' + JSON.stringify(narrow.where));
  check('and the round is left two apart rather than flattened',
    narrow.gap === 2, JSON.stringify(narrow.load));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
