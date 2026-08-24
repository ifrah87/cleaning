/**
 * Adding a room to TODAY from the phone, and ticking it off.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/add-room-today.js
 *
 * Three things the office asked for, in the order they happen:
 *   1. a room that today's schedule did not ask for goes on today's list with one tap,
 *   2. an Airbnb room — off the morning roll call by kind — can be put on today's board
 *      as a one-off, without moving the kind onto the roll call,
 *   3. tapping the room marks it cleaned, and the TV shows it green.
 *
 * SAFETY: never touches the live Supabase project. Every request to *.supabase.co is
 * answered from the fixtures below. Writes are KEPT, so the second page (the TV) reads
 * back what the first page (the phone) pushed — which is the whole point of step 3.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';

const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
// The work day rolls at 3am, same as the app's own.
const WORK_TODAY = (() => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); return key(d); })();
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const STAFF = [
  { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [1, 2], hikPersonId: 'h1' },
  // Cleared for Airbnb as well — the added room has to have somebody who may take it.
  { id: 'p3', name: 'Hodan Omar', crew: 'Team B', isCleaner: true, isLeader: true, floors: [], hikPersonId: 'h3', canClean: ['building', 'office', 'airbnb'] },
];
const U = (id, unit, type, freq, last, extra) => Object.assign({ id, unit, type, freq, lastCleaned: last }, extra || {});
let APP_STATE = {
  staff: STAFF,
  servicedUnits: [
    U('u1', '101', 'building', 'daily', DAY_BEFORE),          // due today
    U('u6', 'Suite 9', 'office', 'weekly', DAY_BEFORE),       // NOT due today
    U('u5', 'A1', 'airbnb', 'daily', DAY_BEFORE),             // off the roll call by kind
  ],
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
};
const EVENTS = [{ person_name: 'Hodan Omar', person_code: '1003', event_time: WORK_TODAY + ' 06:30:00' }];

function serve() {
  return new Promise((r) => {
    const s = http.createServer((q, res) => {
      const f = q.url.split('?')[0] === '/' ? '/index.html' : q.url.split('?')[0];
      const p = path.join(ROOT, f);
      if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/plain' });
      res.end(fs.readFileSync(p));
    });
    s.listen(0, '127.0.0.1', () => r({ s, port: s.address().port }));
  });
}

const out = [];
const check = (n, c, d) => { out.push([n, !!c]); console.log((c ? '  \x1b[32mPASS\x1b[0m ' : '  \x1b[31mFAIL\x1b[0m ') + n + (c || !d ? '' : '\n       ' + d)); };

// The board is written by whoever did the work and read by everyone else, so the
// fixture behaves like the real row: a push replaces it, a pull returns what was pushed.
function routeSupabase(ctx) {
  return ctx.route(`**://${SUPA_HOST}/**`, async (route) => {
    const req = route.request(), url = req.url(), m = req.method();
    const json = (b, st = 200) => route.fulfill({ status: st, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(b) });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }, body: '' });
    if (url.includes('/auth/v1/token')) return json(SESSION);
    if (url.includes('/auth/v1/user')) return json(SESSION.user);
    if (url.includes('/rest/v1/app_state')) {
      if (m === 'GET') {
        const single = String(req.headers()['accept'] || '').includes('pgrst.object');
        const row = { data: APP_STATE };
        return json(single ? row : [row]);
      }
      try {
        const body = JSON.parse(req.postData() || '{}');
        const rec = Array.isArray(body) ? body[0] : body;
        if (rec && rec.data) APP_STATE = rec.data;      // the phone's push becomes the shared copy
      } catch (e) {}
      return json([{}], 201);
    }
    if (url.includes('/rest/v1/hik_events')) return json(m === 'GET' ? EVENTS : [{}]);
    if (url.includes('/rest/v1/cleaning_log')) return json([], m === 'POST' ? 201 : 200);
    return json([]);
  });
}

// The chips in "Rooms to clean today", by their text. Scoped to that section so a room
// named in the not-due list below cannot be mistaken for one on today's board.
const todayChips = (page) => page.locator('.body > div', { has: page.locator('.section-label', { hasText: 'Rooms to clean today' }) }).locator('button.freqmini');

(async () => {
  const { s, port } = await serve();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await routeSupabase(ctx);
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);

  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (x) => { if (x.type() === 'error') errs.push(x.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.nav', { timeout: 20000 });
  await page.waitForTimeout(2500);

  console.log('\n\x1b[1mPHONE — adding a room to today\x1b[0m');

  // --- 1. a room that is not due today ---------------------------------------
  let body = await page.locator('.body').first().textContent();
  check('a room that is not due is listed as not due', body.includes('Not due today'), body.slice(0, 120));
  check('and the list says a tap adds it', body.includes('tap one to add it to today'));
  check('Suite 9 is not on today’s list to start with',
    !(await todayChips(page).allTextContents()).join(' ').includes('Suite 9'));

  await page.locator('button.freqmini', { hasText: 'Suite 9' }).first().click();
  await page.waitForTimeout(600);
  check('tapping it puts it on today’s list',
    (await todayChips(page).allTextContents()).join(' ').includes('Suite 9'),
    (await todayChips(page).allTextContents()).join(' | '));
  body = await page.locator('.body').first().textContent();
  check('and it is shown as added by hand, with a way back off', body.includes('Added to today by hand'));

  // --- 2. an Airbnb room, off the roll call by kind ---------------------------
  check('Airbnb is offered as off the roll call', body.includes('off the roll call'), body.slice(0, 200));
  check('A1 is not on the morning list yet',
    !(await todayChips(page).allTextContents()).join(' ').includes('A1'));
  await page.locator('button.freqmini', { hasText: /^＋ A1/ }).first().click();
  await page.waitForTimeout(600);
  check('tapping the Airbnb room puts it on the morning list too',
    (await todayChips(page).allTextContents()).join(' ').includes('A1'),
    (await todayChips(page).allTextContents()).join(' | '));

  // --- 3. tap the room to mark it cleaned ------------------------------------
  const a1 = todayChips(page).filter({ hasText: 'A1' }).first();
  check('it is not ticked yet', !(await a1.textContent()).includes('✓'), await a1.textContent());
  await a1.click();
  await page.waitForTimeout(800);
  const a1txt = await todayChips(page).filter({ hasText: 'A1' }).first().textContent();
  check('tapping the room marks it cleaned', a1txt.includes('✓'), a1txt);

  // --- the TV reads it back ---------------------------------------------------
  const tv = await ctx.newPage();
  const tvErrs = [];
  tv.on('pageerror', (e) => tvErrs.push('pageerror: ' + e.message));
  await tv.goto(`http://127.0.0.1:${port}/index.html?tv=1`, { waitUntil: 'domcontentloaded' });
  await tv.waitForSelector('.tv-wrap', { timeout: 20000 });
  await tv.waitForTimeout(3000);
  const jobs = await tv.locator('.tv-job').allTextContents();
  check('the added Airbnb room is on the main TV board', jobs.join(' ').includes('A1'), jobs.join(' | '));
  const doneJobs = await tv.locator('.tv-job.done').allTextContents();
  check('and the TV shows it green', doneJobs.join(' ').includes('A1'), doneJobs.join(' | '));
  check('the room added by hand is on the board as well', jobs.join(' ').includes('Suite 9'), jobs.join(' | '));

  // --- taking one back off ----------------------------------------------------
  await page.bringToFront();
  await page.locator('button.freqmini', { hasText: /^Suite 9 ✕$/ }).first().click();
  await page.waitForTimeout(600);
  check('an added room can be taken back off',
    !(await todayChips(page).allTextContents()).join(' ').includes('Suite 9'),
    (await todayChips(page).allTextContents()).join(' | '));
  const addedTxt = await page.locator('.body').first().textContent();
  check('a room already cleaned is not offered for removal', !/A1 ✕/.test(addedTxt));

  // The kind itself must not have moved onto the roll call.
  const stillOff = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('cleaning_app_v5') || '{}');
    return { types: s.rollCallTypes || null };
  });
  check('Airbnb as a KIND is still off the roll call',
    !stillOff.types || !stillOff.types.includes('airbnb'), JSON.stringify(stillOff));

  const realErrs = errs.concat(tvErrs).filter((e) => !/WebSocket|ERR_INTERNET_DISCONNECTED|net::/.test(e));
  check('no console errors', realErrs.length === 0, realErrs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
