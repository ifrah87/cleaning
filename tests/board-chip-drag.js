/**
 * DRAGGING A ROOM ACROSS THE BOARD, BY THE CHIP AND NOT BY THE GRIP.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/board-chip-drag.js
 *
 * The board's chips could only be dragged by a 14px ⠿ handle. Anywhere else on the chip
 * did nothing, and the label ticked the room off, so a room dragged at somebody's column
 * looked like it flatly refused to move. With a mouse the whole chip is the handle now.
 *
 * The trap this guards: capturing the pointer on pointerdown makes the chip the target of
 * the click that follows, so the click never reaches the label and a TAP stops ticking a
 * room off — twenty times a day, silently broken. Capture waits for the first move.
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
    // Hodan needs a room of her own, or she is holding nothing and the board gives
    // her no column — and a column is what a room is dropped on.
    { id: 'su301', unit: '301', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p2' },
    { id: 'su406', unit: '406', type: 'airbnb', freq: 'daily', preferLate: true, lastCleaned: DAY_BEFORE },
    { id: 'su506', unit: '506', type: 'airbnb', freq: 'daily', preferLate: true, lastCleaned: DAY_BEFORE },
  ],
  areas: [{ id: 'corridors', label: 'Corridors', kind: 'interior', freq: 'daily', assignedTo: 'p1' }],
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  rollCallTypes: ['office', 'building'],   // as in the building: Airbnb is its own job
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
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

  console.log('\n\x1b[1mA room is dragged across the board by its chip\x1b[0m');

  await page.evaluate(() => { setTab('board'); render(); });
  await page.waitForTimeout(900);

  const chipFor = (n) => page.locator('.bd-job', { hasText: new RegExp('^' + n) }).first();

  check('the board is showing the rooms', await chipFor('406').count() > 0, 'no 406 chip on the board');
  check('and both cleaners have a column to drop on',
    await page.locator('[data-drop]').count() >= 2,
    (await page.locator('[data-drop]').count()) + ' drop targets');

  // --- a TAP on the chip still ticks the room off ------------------------------
  // This is the one that breaks if the chip captures the pointer too early.
  const before = await page.evaluate(() => cleanedToday(state.servicedUnits.find((u) => u.unit === '101')));
  await chipFor('101').locator('.bd-lbl').click();
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => cleanedToday(state.servicedUnits.find((u) => u.unit === '101')));
  check('tapping a chip still ticks the room off', !before && after, `before=${before} after=${after}`);

  // put it back, so the drag below is not confused by a done room
  await chipFor('101').locator('.bd-lbl').click();
  await page.waitForTimeout(700);

  // --- a DRAG by the chip body, nowhere near the grip --------------------------
  const flat = chipFor('406');
  const lbl = flat.locator('.bd-lbl');
  const target = page.locator('[data-drop="p2"]').first();
  const a = await lbl.boundingBox(), b = await target.boundingBox();
  check('406 and a column to drop it on are both on screen', !!a && !!b, JSON.stringify({ a: !!a, b: !!b }));

  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 30, a.y + a.height / 2 + 30, { steps: 6 });
  await page.mouse.move(b.x + b.width / 2, b.y + 30, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(900);

  const moved = await page.evaluate(() => {
    const u = state.servicedUnits.find((x) => x.unit === '406');
    return { to: u.assignedTo, done: cleanedToday(u) };
  });
  check('dragging the chip body hands the room over', moved.to === 'p2', JSON.stringify(moved));
  check('and it is not ticked off as done on the way', moved.done === false, JSON.stringify(moved));

  // --- and it is now in that person's column, not where it started -------------
  const where = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.bd-col')];
    const col = cols.find((c) => [...c.querySelectorAll('.bd-lbl')].some((l) => /^406/.test(l.textContent)));
    if (!col) return { col: null };
    return { none: col.classList.contains('none'), drop: col.getAttribute('data-drop') };
  });
  check('the chip has moved out of NOBODY YET into their box',
    where.col !== null && where.none === false && where.drop === 'p2', JSON.stringify(where));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
