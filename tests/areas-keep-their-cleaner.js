/**
 * AN AREA'S CLEANER IS NOT THE PLAN'S TO ERASE.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/areas-keep-their-cleaner.js
 *
 * autoPlanDay leaves communal areas alone on purpose — "an area is a walk of the
 * building rather than a room on a count, and who does it is a call for the morning" —
 * so every area on every plan carries assignedTo: null, for ever. mirrorPlanToBoard
 * then writes the plan onto the board with `a.assignedTo = j.assignedTo || null`, and
 * unless the caller passes keepBoard that null lands on the board. So "⚡ Plan this
 * day" on today, or sharing an absent person's rooms out, silently clears the cleaner
 * off every interior area — the lobby, the trash, the lifts, the mosque — while the
 * rooms beside them are untouched.
 *
 * On 1 Sep the live board had Mosque and OFFSITE-2 DHAGAX sitting unassigned with
 * five other interior areas still named, which is this bug caught mid-sweep.
 *
 * SAFETY: never touches the live Supabase project; every request to *.supabase.co is
 * answered from the fixtures below.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';

const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const back = (n) => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); d.setDate(d.getDate() - n); return key(d); };

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const APP_STATE = {
  staff: [
    { id: 'p1', name: 'Hassan Mohamed Elmi', crew: 'Team A', isCleaner: true, isLeader: true, floors: [], worksOn: [0, 1, 2, 3, 4, 5, 6] },
    { id: 'p2', name: 'Mahad Hussein Hassan', crew: 'Team B', isCleaner: true, isLeader: true, floors: [], worksOn: [0, 1, 2, 3, 4, 5, 6] },
  ],
  // The interior areas as the live building has them, each already walked by somebody.
  areas: [
    { id: 'lobby', label: 'Main Lobby/Office', kind: 'interior', freq: 'daily', assignedTo: 'p1' },
    { id: 'trash', label: 'Trash / Recycling', kind: 'interior', freq: 'daily', assignedTo: 'p2' },
    { id: 'elevator', label: 'Elevators / Lifts', kind: 'interior', freq: 'daily', assignedTo: 'p1' },
  ],
  // One room, so the day has something to share out and the plan is not empty.
  servicedUnits: [
    { id: 'su401', unit: '401', type: 'office', freq: 'daily', lastCleaned: back(2), assignedTo: 'p1' },
  ],
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  autoAssign: false, autoBalance: false,
  autoDaysOn: key(new Date()), eodLevelledOn: key(new Date()),
};

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
        return json(single ? { data: APP_STATE } : [{ data: APP_STATE }]);
      }
      return json([{}], 201);
    }
    return json([]);
  });
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.header', { timeout: 20000 });
  await page.waitForTimeout(2500);

  console.log('\n\x1b[1mAn area keeps its cleaner when the plan is put on the board\x1b[0m');

  const r = await page.evaluate(() => {
    const day = workToday();
    const who = () => (state.areas || []).reduce((m, a) => { m[a.id] = a.assignedTo || null; return m; }, {});

    // Lay the day out the way the app does, then read what the plan says about areas.
    ensureDayPlanned(day);
    const plan = getPlan(day);
    const areaRows = Object.keys(plan).filter((k) => plan[k].kind === 'area');
    const areasNamedInPlan = areaRows.filter((k) => plan[k].assignedTo).length;

    const before = who();
    // "⚡ Plan this day" on today, reduced to the line that touches the board.
    mirrorPlanToBoard(day);
    const after = who();

    // ...but a person taking the name off an area in the plan still means it. That
    // goes through setPlanAssignee, which mirrors the one key it changed.
    const lobbyKey = areaRows.find((k) => plan[k].refId === 'lobby');
    setPlanAssignee(day, lobbyKey, null);
    const afterHandClear = who();
    // And naming a leader on an area in the plan still reaches the board.
    setPlanAssignee(day, lobbyKey, 'p2');
    const afterHandSet = who();

    return { day, areaRows: areaRows.length, areasNamedInPlan, before, after, afterHandClear, afterHandSet };
  });

  check('the plan lays areas out with no cleaner on them (by design)',
    r.areaRows > 0 && r.areasNamedInPlan === 0,
    `${r.areaRows} areas on the plan, ${r.areasNamedInPlan} carrying a name`);
  check('the board starts with every interior area walked by somebody',
    Object.values(r.before).every((v) => v), JSON.stringify(r.before));
  check('putting the plan on the board does NOT clear those cleaners',
    Object.keys(r.before).every((id) => r.after[id] === r.before[id]),
    'before: ' + JSON.stringify(r.before) + '\n       after:  ' + JSON.stringify(r.after));
  check('taking the name off an area by hand still clears it',
    r.afterHandClear.lobby === null, JSON.stringify(r.afterHandClear));
  check('naming a leader on an area by hand still reaches the board',
    r.afterHandSet.lobby === 'p2', JSON.stringify(r.afterHandSet));
  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
