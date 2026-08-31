/**
 * A COPY FROM BEFORE A CHANGE MUST NOT LAND ON TOP OF IT.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/stale-copy-cannot-overwrite.js
 *
 * This is the Sunday night, reproduced. A cleaner was archived on one device. A second
 * device — a phone left open, a laptop that slept — was still holding the board as it
 * was BEFORE the archive. When somebody touched that device it sent its whole copy, the
 * server took it, and the archived man's name was back on three rooms and seventy-three
 * planned days by morning. The tombstone kept him off the roster, so nothing showed him
 * on any column: the rooms simply sat in NOBODY YET, assigned to a name with nobody
 * behind it, and two of them went uncleaned.
 *
 * The server row carries updated_at. A write is now conditional on it still being the
 * value this device last read, so a stale copy matches no row and is refused; the device
 * then pulls, merges its own stamped edits onto what arrived, and tries again.
 *
 * Also checked here: the television never writes at all, whatever state it is in.
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

// v1 — the board as it was before anybody was archived. This is what the stale device
// is holding, and what it will try to send.
const V1 = {
  staff: [
    { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [4], hikPersonId: 'h1' },
    { id: 'p2', name: 'Bilan Warsame', crew: 'Team B', isCleaner: true, isLeader: true, floors: [3], hikPersonId: 'h2' },
  ],
  servicedUnits: [
    { id: 'su401', unit: '401', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
    { id: 'su301', unit: '301', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p2', usualTo: 'p2' },
  ],
  areas: [{ id: 'lobby', label: 'Main Lobby/Office', kind: 'interior', freq: 'daily', assignedTo: 'p2' }],
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
};

// v2 — Bilan archived on the OTHER device, exactly as removeEmployee leaves it: off the
// roster, tombstoned, and everything that was hers handed back.
const V2 = JSON.parse(JSON.stringify(V1));
V2.staff = V2.staff.filter((p) => p.id !== 'p2');
V2.removedStaff = { p2: WORK_TODAY };
V2.servicedUnits.forEach((u) => {
  if (u.assignedTo === 'p2') u.assignedTo = null;
  if (u.usualTo === 'p2') u.usualTo = null;
});
V2.areas.forEach((a) => { if (a.assignedTo === 'p2') a.assignedTo = null; });

const EVENTS = [{ person_name: 'Amina Yusuf', person_code: '1', event_time: WORK_TODAY + ' 06:30:00' }];

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

  // THE SERVER, WITH THE ONE PROPERTY THAT MATTERS: a conditional write really is
  // conditional. PostgREST applies ?updated_at=eq.X only when the row still holds X and
  // returns the rows it changed — none, if somebody got there first.
  let ROW = { data: JSON.parse(JSON.stringify(V1)), updated_at: '2026-08-30T18:00:00.000Z' };
  let blindWrites = 0, refused = 0;

  const mount = async (ctx) => {
    await ctx.route(`**://${SUPA_HOST}/**`, async (route) => {
      const req = route.request(), url = req.url(), m = req.method();
      const json = (b, st = 200) => route.fulfill({ status: st, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(b) });
      if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }, body: '' });
      if (url.includes('/auth/v1/token')) return json(SESSION);
      if (url.includes('/auth/v1/user')) return json(SESSION.user);
      if (url.includes('/rest/v1/hik_events')) return json(m === 'GET' ? EVENTS : [{}]);
      if (url.includes('/rest/v1/app_state')) {
        if (m === 'GET') {
          const single = String(req.headers()['accept'] || '').includes('pgrst.object');
          const row = { data: ROW.data, updated_at: ROW.updated_at };
          return json(single ? row : [row]);
        }
        let body = {};
        try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
        const rec = Array.isArray(body) ? body[0] : body;
        const want = new URL(url).searchParams.get('updated_at');
        if (want) {
          // A guarded write: only if the row still holds the version they read.
          const expect = want.replace(/^eq\./, '');
          if (expect !== ROW.updated_at) { refused += 1; return json([]); }
          ROW = { data: rec.data, updated_at: rec.updated_at || new Date().toISOString() };
          return json([{ updated_at: ROW.updated_at }]);
        }
        // An unguarded write — the old behaviour, and the thing this test exists about.
        blindWrites += 1;
        ROW = { data: rec.data, updated_at: rec.updated_at || new Date().toISOString() };
        return json([{ updated_at: ROW.updated_at }], 201);
      }
      return json([]);
    });
    await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  };

  // --- the stale device: pulls v1, then the world moves on underneath it -----------
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await mount(ctx);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.header', { timeout: 20000 });
  await page.waitForTimeout(3000);

  console.log('\n\x1b[1mA copy from before the archive cannot land on top of it\x1b[0m');

  check('the device has the board as it was, with Bilan on it',
    await page.evaluate(() => (state.staff || []).some((p) => p.name === 'Bilan Warsame')),
    'the fixture never loaded');

  // Somebody archives Bilan on ANOTHER device. This one is not told: no socket, no pull.
  ROW = { data: JSON.parse(JSON.stringify(V2)), updated_at: '2026-08-30T19:37:00.000Z' };

  // ...and now somebody touches the stale device, which saves its whole copy.
  await page.evaluate(() => {
    const u = state.servicedUnits.find((x) => x.unit === '401');
    setUnitFreq(u.id, 'weekly');            // an ordinary edit, of the kind anybody makes
  });
  for (let i = 0; i < 60; i += 1) {
    const owed = await page.evaluate(() => (localStorage.getItem('cleaning_app_v5_dirty') === '1'));
    if (!owed) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1500);

  const after = ROW.data;
  check('the archived cleaner is NOT back on the roster',
    !(after.staff || []).some((p) => p.name === 'Bilan Warsame'),
    JSON.stringify((after.staff || []).map((p) => p.name)));
  check('the record that she was removed is still there',
    !!(after.removedStaff && after.removedStaff.p2),
    JSON.stringify(after.removedStaff || null));
  check('and her name is not back on the room she used to have',
    !(after.servicedUnits || []).some((u) => u.assignedTo === 'p2' || u.usualTo === 'p2'),
    JSON.stringify((after.servicedUnits || []).map((u) => u.unit + ':' + (u.assignedTo || '-') + '/' + (u.usualTo || '-'))));
  check('nor on the communal walk',
    !(after.areas || []).some((a) => a.assignedTo === 'p2'),
    JSON.stringify((after.areas || []).map((a) => a.label + ':' + (a.assignedTo || '-'))));
  check('the server refused the write made against the old version', refused > 0,
    'refused=' + refused + ' blind=' + blindWrites);
  check('...and nothing was written without naming a version', blindWrites === 0,
    'blind writes: ' + blindWrites);
  // The device's own edit is not collateral: it made one, and it must survive the merge.
  check('the edit made on the stale device survived',
    ((after.servicedUnits || []).find((u) => u.unit === '401') || {}).freq === 'weekly',
    JSON.stringify((after.servicedUnits || []).map((u) => u.unit + ':' + u.freq)));

  await page.close();

  // --- the television, which must never write, whatever it is holding -------------
  const before = JSON.stringify(ROW);
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await mount(tvCtx);
  const tv = await tvCtx.newPage();
  tv.on('pageerror', (e) => errs.push('tv pageerror: ' + e.message));
  await tv.goto(`http://127.0.0.1:${port}/index.html?tv=1`, { waitUntil: 'domcontentloaded' });
  await tv.waitForSelector('.tv-wrap', { timeout: 20000 });
  await tv.waitForTimeout(2500);
  const tvPushed = await tv.evaluate(async () => {
    localStorage.setItem('cleaning_app_v5_dirty', '1');   // as if it were owed something
    return await pushNow();                               // ...and asked to send it
  });
  await tv.waitForTimeout(1500);
  check('the television will not write, even when it thinks it owes something',
    tvPushed === false && JSON.stringify(ROW) === before,
    'pushNow returned ' + tvPushed);

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
