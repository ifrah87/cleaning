/**
 * NOBODY STARTS THE MORNING HOLDING FOUR ASKED-FOR ROOMS.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/early-evened.js
 *
 * The early rooms are the ones the customer asked a time for, and the hand-out has always
 * capped them at two each — but the hand-out is switched off on this building, so nothing
 * enforced it and the pins did the allocating instead. This levels the early round once,
 * at the first sight of the day, and then never again: no movement once people are
 * working, which is the other half of what the office asked for.
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
// NOT A FRIDAY, EVER. "Cleaned the day before" is how nearly every fixture here makes a
// room due today — and the daily rooms are cleaned on the Friday in advance of the
// Saturday, so on a Saturday that clean covers today and the room is deliberately NOT
// due. A fixture pinned to literal yesterday therefore passes six days a week and fails
// on the seventh, taking the board, the hand-out and the levelling tests down with it
// for reasons that have nothing to do with what they are testing. Step back past a
// Friday so "recently cleaned, due today" means that whatever day the suite is run.
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); while (d.getDay() === 5) d.setDate(d.getDate() - 1); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const L = (id, name, crew, floors, hik) => ({ id, name, crew, isCleaner: true, isLeader: true, floors, hikPersonId: hik });
// Four early rooms all pinned to one person — the shape the office actually has.
const R = (id, unit, who) => ({ id, unit, type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE,
  preferEarly: true, usualTo: who, assignedTo: who });
const APP_STATE = {
  staff: [L('p1', 'Amina Yusuf', 'Team A', [4], 'h1'), L('p2', 'Hodan Omar', 'Team B', [3], 'h2'),
          L('p3', 'Sofia Reyes', 'Team C', [2], 'h3')],
  servicedUnits: [
    R('su401', '401', 'p1'), R('su402', '402', 'p1'), R('su403', '403', 'p1'), R('su404', '404', 'p1'),
    { id: 'su301', unit: '301', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p2' },
  ],
  areas: [], completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  autoAssign: false,                 // as on the live building: nothing deals or re-deals
};
let SERVER = APP_STATE;   // the fixture is where the server STARTS, not what it always says

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
        return json(single ? { data: SERVER } : [{ data: SERVER }]);
      }
      // A SERVER THAT KEEPS WHAT IT IS SENT. Answering every read with the same pristine
      // fixture models a server that loses every write, and the app polls: anything the
      // page decided was handed straight back to it a second later, undone. The levelling
      // pass moved two early rooms, said so on screen, and the next poll put them back on
      // the person it had just taken them off. Upsert what arrives, the way the real one does.
      try {
        const body = JSON.parse(req.postData() || '{}');
        const row = Array.isArray(body) ? body[0] : body;
        if (row && row.data) SERVER = row.data;
      } catch (e) { /* a body we cannot read is a write we cannot keep */ }
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

  console.log('\n\x1b[1mThe early round is levelled once, at the start of the day\x1b[0m');

  const after = await page.evaluate(() => {
    const nm = {}; (state.staff || []).forEach((p) => { nm[p.id] = p.name; });
    const load = {};
    todaysRoomList().filter((u) => timeSlot(u) === 'early').forEach((u) => {
      const w = nm[u.assignedTo] || 'nobody';
      load[w] = (load[w] || 0) + 1;
    });
    return { load, cap: earlyCap(), stamped: state.earlyEvenedOn === workToday(),
             said: (state.lastEarlyEven || {}).moves || [],
             pinsIntact: state.servicedUnits.filter((u) => u.usualTo === 'p1').map((u) => u.unit).sort(),
             decided: state.servicedUnits.filter((u) => (state.assignConfirmed || {})[u.id]).map((u) => u.unit).sort() };
  });

  const worst = Math.max(...Object.values(after.load));
  check('nobody is left holding more than the cap', worst <= after.cap, JSON.stringify(after.load));
  check('and the early rooms are spread, not stacked',
    Object.keys(after.load).length >= 2, JSON.stringify(after.load));
  check('it says what it moved', after.said.length > 0, JSON.stringify(after.said));
  check('every move is a decision, so the day cannot re-deal it',
    after.decided.length >= after.said.length, JSON.stringify(after.decided));
  check('the pins are untouched — they are standing instructions',
    JSON.stringify(after.pinsIntact) === JSON.stringify(['401', '402', '403', '404']), JSON.stringify(after.pinsIntact));

  // ...and once only. Move something by hand, run the pass again, nothing stirs.
  const again = await page.evaluate(() => {
    const u = state.servicedUnits.find((x) => x.unit === '401');
    u.assignedTo = 'p1';                       // the office puts it back where it wants it
    const before = state.servicedUnits.map((x) => x.unit + ':' + (x.assignedTo || '-')).join(',');
    evenOutEarlyRooms();
    return { same: before === state.servicedUnits.map((x) => x.unit + ':' + (x.assignedTo || '-')).join(',') };
  });
  check('it does not run twice, so nothing moves once people are working', again.same === true, JSON.stringify(again));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
