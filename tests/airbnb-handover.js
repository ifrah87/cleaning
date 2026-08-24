/**
 * MOVING A GUEST FLAT ONTO WHOEVER CLEANED IT.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/airbnb-handover.js
 *
 * Which flats get done, and by whom, is decided by who checked out and who was free —
 * never by a schedule — so it is always somebody moving work onto somebody. On a desktop
 * that is a drag; on a phone a finger dragging down the screen is a scroll, so the same
 * gesture degrades to tap the flat, tap the person. This checks both land in one place.
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
const APP_STATE = {
  staff: [
    { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [1], hikPersonId: 'h1', canClean: ['building', 'office', 'airbnb'] },
    { id: 'p2', name: 'Hodan Omar', crew: 'Team B', isCleaner: true, isLeader: true, floors: [3], hikPersonId: 'h2', canClean: ['building', 'office', 'airbnb'] },
  ],
  servicedUnits: [
    { id: 'su101', unit: '101', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
    { id: 'su406', unit: '406', type: 'airbnb', freq: 'daily', preferLate: true, lastCleaned: DAY_BEFORE },
    { id: 'su506', unit: '506', type: 'airbnb', freq: 'daily', preferLate: true, lastCleaned: DAY_BEFORE },
  ],
  areas: [{ id: 'corridors', label: 'Corridors', kind: 'interior', freq: 'daily', assignedTo: 'p1' }],
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
};
const EVENTS = [
  { person_name: 'Amina Yusuf', person_code: '1', event_time: WORK_TODAY + ' 06:30:00' },
  { person_name: 'Hodan Omar', person_code: '2', event_time: WORK_TODAY + ' 06:35:00' },
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

  console.log('\n\x1b[1mA guest flat goes to whoever cleaned it\x1b[0m');

  // The morning set-up lives behind ☰ now — the board is the screen you land on.
  await page.evaluate(() => {
    setTab('rollcall');
    // Who's in folds shut by default; the cards inside it are what a job is dropped on.
    state.rcFold = Object.assign({}, state.rcFold, { whoin: true, airbnb: true });
    render();
  });
  await page.waitForTimeout(700);

  const body = await page.locator('.body').first().textContent();
  check('the flats are on the roll call', /Airbnb \(\d\/\d done\)/.test(body), body.slice(0, 200));
  check('and it says how to move one', /tap whoever cleaned it/i.test(body), 'no instruction line');

  // --- tap to pick up, tap to put down (the phone gesture) ---------------------
  await page.locator('button.freqmini', { hasText: /^406/ }).first().click();
  await page.waitForTimeout(500);
  check('tapping a flat picks it up', await page.evaluate(() => !!_picked && _picked.label === '406'),
    await page.evaluate(() => JSON.stringify(_picked)));
  const held = await page.locator('.body').first().textContent();
  check('and the screen says what is in your hand', /406 is in your hand/.test(held), held.slice(0, 200));

  await page.locator('[data-drop]').first().click();
  await page.waitForTimeout(700);
  const placed = await page.evaluate(() => {
    const u = state.servicedUnits.find((x) => x.unit === '406');
    return { to: u.assignedTo, hand: _picked, confirmed: (state.assignConfirmed || {})[u.id] || null };
  });
  check('tapping a cleaner gives them the flat', !!placed.to, JSON.stringify(placed));
  check('and your hand is empty again', placed.hand === null, JSON.stringify(placed));
  check('it counts as a decision, so the morning will not re-deal it',
    placed.confirmed === (await page.evaluate(() => todayKey())), JSON.stringify(placed));

  // Tapping the same flat twice puts it down rather than leaving it stuck in hand.
  await page.locator('button.freqmini', { hasText: /^506/ }).first().click();
  await page.waitForTimeout(400);
  await page.locator('button.freqmini', { hasText: /^506/ }).first().click();
  await page.waitForTimeout(400);
  check('tapping it again puts it down', await page.evaluate(() => _picked === null),
    await page.evaluate(() => JSON.stringify(_picked)));

  // --- drag it, the way a mouse would (the desktop gesture) --------------------
  const flat = page.locator('button.freqmini', { hasText: /^506/ }).first();
  const target = page.locator('[data-drop]').last();
  const a = await flat.boundingBox(), b = await target.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 40, a.y + a.height / 2 + 40, { steps: 6 });
  await page.mouse.move(b.x + b.width / 2, b.y + 20, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const dragged = await page.evaluate(() => {
    const u = state.servicedUnits.find((x) => x.unit === '506');
    return { to: u.assignedTo, name: (state.staff.find((p) => p.id === u.assignedTo) || {}).name || null };
  });
  check('dragging a flat onto somebody hands it to them', !!dragged.to, JSON.stringify(dragged));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
