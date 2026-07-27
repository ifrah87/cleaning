/**
 * End-to-end test for the Cleaning Ops app.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/e2e.js
 *
 * SAFETY: this test NEVER touches the live Supabase project. Every request to
 * *.supabase.co is intercepted and answered from the fixtures below — reads are
 * faked, writes are captured and asserted against, and any request to an
 * unexpected Supabase path fails the run. Nothing leaves this machine except the
 * supabase-js bundle fetched from the CDN.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';

// --- date helpers, mirroring the app's own key format -----------------------
const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const TODAY = key(new Date());
const YESTERDAY = key(new Date(Date.now() - 864e5));

// --- fixtures ---------------------------------------------------------------
// Three cleaners; Hodan never badges in, so she must not appear on the roll call.
const STAFF = [
  { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, floors: [] },
  { id: 'p2', name: 'Fatima Ali', crew: 'Team A', isCleaner: true, floors: [] },
  { id: 'p3', name: 'Hodan Omar', crew: 'Team B', isCleaner: true, floors: [] },
  { id: 'p4', name: 'Office Person', crew: 'Team A', isCleaner: false, floors: [] },
];

// Rooms chosen to cover every branch of "is this on today's list":
//   101 daily,  cleaned yesterday          -> due, unassigned
//   102 daily,  cleaned TODAY              -> on the list but done
//   103 eod,    cleaned yesterday          -> NOT due (next tomorrow)
//   104 daily,  never cleaned              -> due, already handed to Amina
//   105 daily,  cleaned yesterday, early   -> due, unassigned, sorts first
//   201 weekly, cleaned yesterday (office) -> NOT due
const UNITS = [
  { id: 'u101', unit: '101', type: 'airbnb', freq: 'daily', lastCleaned: YESTERDAY, assignedTo: null, usualTo: null },
  { id: 'u102', unit: '102', type: 'airbnb', freq: 'daily', lastCleaned: TODAY, assignedTo: null, usualTo: null },
  { id: 'u103', unit: '103', type: 'airbnb', freq: 'eod', lastCleaned: YESTERDAY, assignedTo: null, usualTo: null },
  { id: 'u104', unit: '104', type: 'airbnb', freq: 'daily', lastCleaned: null, assignedTo: 'p1', usualTo: null , priority: true },
  { id: 'u105', unit: '105', type: 'airbnb', freq: 'daily', lastCleaned: YESTERDAY, assignedTo: null, usualTo: null, preferEarly: true },
  { id: 'u201', unit: '201', type: 'office', freq: 'weekly', lastCleaned: YESTERDAY, assignedTo: null, usualTo: null },
];

const APP_STATE = {
  servicedUnits: UNITS,
  staff: STAFF,
  attendance: {},
  completions: {},
  coverage: {},
  unitCover: {},
  coverageDay: TODAY,
  floors: 11,
  plans: {},
  manualArrivals: {},
};

// Amina and Fatima badged in; Hodan did not.
const HIK_EVENTS = [
  { person_name: 'Amina Yusuf', person_code: '1001', event_time: TODAY + ' 06:12:00' },
  { person_name: 'Fatima Ali', person_code: '1002', event_time: TODAY + ' 06:40:00' },
];

const SESSION = {
  access_token: 'test-access-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 4102444800, // year 2100 — never triggers a refresh
  refresh_token: 'test-refresh-token',
  user: { id: 'test-user', aud: 'authenticated', role: 'authenticated', email: 'test@example.com' },
};

// --- tiny assertion harness -------------------------------------------------
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? '  \x1b[32mPASS\x1b[0m ' : '  \x1b[31mFAIL\x1b[0m ') + name + (cond || !detail ? '' : '\n       ' + detail));
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
}
function contains(name, hay, needle) {
  check(name, String(hay).includes(needle), `expected to contain: ${JSON.stringify(needle)}\n       actual: ${JSON.stringify(String(hay).slice(0, 300))}`);
}

// --- static server ----------------------------------------------------------
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
      const p = path.join(ROOT, f);
      if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'text/plain' });
      res.end(fs.readFileSync(p));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async () => {
  const { srv, port } = await serve();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });

  const writes = [];        // every app_state upsert the app attempted
  const unexpected = [];    // any Supabase path we didn't plan for

  await ctx.route(`**://${SUPA_HOST}/**`, async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body),
    });

    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }, body: '' });
    if (url.includes('/auth/v1/token')) return json(SESSION);
    if (url.includes('/auth/v1/user')) return json(SESSION.user);
    if (url.includes('/auth/v1/logout')) return json({});

    if (url.includes('/rest/v1/app_state')) {
      if (method === 'GET') {
        // .maybeSingle() asks for a bare object via Accept; plain selects want an array.
        const single = String(req.headers()['accept'] || '').includes('pgrst.object');
        const row = { data: APP_STATE };
        return json(single ? row : [row]);
      }
      writes.push(JSON.parse(req.postData() || '{}'));
      return json([{}], 201);
    }
    if (url.includes('/rest/v1/hik_events')) {
      if (method === 'GET') return json(HIK_EVENTS);
      return json([{}], 201);
    }
    if (url.includes('/rest/v1/cleaning_log')) return json([]);

    unexpected.push(method + ' ' + url);
    return json([]);
  });

  // Pre-seed a Supabase session so the app boots straight past the login screen.
  await ctx.addInitScript(([host, session]) => {
    const ref = host.split('.')[0];
    localStorage.setItem('sb-' + ref + '-auth-token', JSON.stringify(session));
  }, [SUPA_HOST, SESSION]);

  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.nav', { timeout: 15000 }).catch(() => {});

  console.log('\n\x1b[1mBOOT\x1b[0m');
  const loggedIn = await page.locator('.nav').count();
  check('app boots past the login screen', loggedIn > 0, 'login screen still showing — session stub failed');
  if (!loggedIn) { await browser.close(); srv.close(); report(); return; }

  // Regression: a device with NO localStorage cache (incognito, cleared cache, new
  // phone) used to land on the dead tab 'cleaning' and render a blank screen.
  const title = await page.locator('.h-title').textContent();
  eq('fresh device with no cache lands on a real tab', title, 'Morning Roll Call');
  check('fresh device renders a body, not a blank screen', (await page.locator('.body').count()) > 0, 'no .body rendered');

  // An empty roll call must be distinguishable from a stale one.
  await page.waitForSelector('#lastPull');
  contains('roll call reports when attendance was last read', await page.locator('#lastPull').textContent(), 'Attendance checked');
  check('there is a manual re-check button', (await page.locator('button', { hasText: 'Check now' }).count()) > 0, 'no "Check now" button');

  // Roll Call is the landing tab; wait for arrivals to resolve.
  await page.waitForSelector('text=/Rooms to clean today/', { timeout: 10000 }).catch(() => {});

  // ---------------------------------------------------------------- ROLL CALL
  console.log('\n\x1b[1mROLL CALL — today\'s rooms panel\x1b[0m');
  const heading = await page.locator('.section-label', { hasText: 'Rooms to clean today' }).first().textContent().catch(() => '');
  contains('panel lists 4 rooms (101,102,104,105 — not the eod/weekly ones)', heading, 'Rooms to clean today (4)');

  const status = await page.locator('.section-label', { hasText: 'Rooms to clean today' }).first()
    .evaluate((e) => e.nextElementSibling.textContent).catch(() => '');
  contains('counts assigned rooms', status, '1 handed out');
  contains('counts unassigned rooms', status, '2 still to hand out');
  contains('counts finished rooms', status, '1 done');

  const chipText = await page.locator('.section-label', { hasText: 'Rooms to clean today' }).first()
    .evaluate((e) => Array.from(e.nextElementSibling.nextElementSibling.children).map((c) => c.textContent.trim())).catch(() => []);
  eq('prefers-early room sorts first', chipText[0], '🌅 105');
  eq('priority room sorts next, ahead of ordinary rooms', chipText[1], '⭐ 104 · Amina ?');
  check('cleaned room is ticked', chipText.includes('102 ✓'), 'chips: ' + JSON.stringify(chipText));
  check('priority room shows its cleaner, flagged as unchecked', chipText.includes('⭐ 104 · Amina ?'), 'chips: ' + JSON.stringify(chipText));
  check('off-schedule rooms are absent', !chipText.some((c) => c.includes('103') || c.includes('201')), 'chips: ' + JSON.stringify(chipText));

  console.log('\n\x1b[1mROLL CALL — who clocked in\x1b[0m');
  const names = await page.locator('.person-name').allTextContents();
  check('only badged-in cleaners are listed', names.length === 2, 'names: ' + JSON.stringify(names));
  check('Hodan (no badge-in) is not listed', !names.join(' ').includes('Hodan'), 'names: ' + JSON.stringify(names));

  console.log('\n\x1b[1mROLL CALL — assign dropdown suggests today\'s rooms\x1b[0m');
  const sel = page.locator('.person select.area-select').first();
  const placeholder = await sel.locator('option').first().textContent();
  contains('placeholder advertises the due count', placeholder, '(2 due today)');
  const groups = await sel.locator('optgroup').evaluateAll((gs) => gs.map((g) => g.label));
  eq('due-today group is first and counted', groups[0], 'Due today (2)');
  eq('not-due group is second and counted', groups[1], 'Not due yet (2)');
  const dueOpts = await sel.locator('optgroup:nth-of-type(1) option').allTextContents();
  eq('prefers-early room is suggested first', dueOpts[0], '🌅 Room 105');
  eq('other due room follows', dueOpts[1], 'Room 101');
  const laterOpts = await sel.locator('optgroup:nth-of-type(2) option').allTextContents();
  check('off-schedule rooms show their next due date', laterOpts.every((o) => o.includes('— next')), 'options: ' + JSON.stringify(laterOpts));
  check('already-cleaned room 102 is not offered', ![...dueOpts, ...laterOpts].some((o) => o.includes('102')), JSON.stringify([...dueOpts, ...laterOpts]));

  console.log('\n\x1b[1mROLL CALL — assigning a room persists + updates the panel\x1b[0m');
  writes.length = 0;
  await sel.selectOption('u101');
  await page.waitForTimeout(700);   // debounced remote push is 250ms
  const afterAssign = await page.locator('.section-label', { hasText: 'Rooms to clean today' }).first()
    .evaluate((e) => e.nextElementSibling.textContent);
  contains('panel now shows 2 handed out', afterAssign, '2 handed out');
  contains('panel now shows 1 left', afterAssign, '1 still to hand out');
  const w = writes[writes.length - 1];
  const saved101 = w && (w.data.servicedUnits || []).find((u) => u.id === 'u101');
  eq('room 101 saved against the cleaner who took it', saved101 && saved101.assignedTo, 'p1');

  // ------------------------------------------------- AUTO-ASSIGN + SIGN-OFF
  console.log('\n\x1b[1mAUTO-ASSIGN — every suggestion needs a yes/no\x1b[0m');
  // Room 104 arrived pre-assigned from the fixture and 101 was hand-picked above,
  // so only auto-assign's own picks should land in the check list.
  writes.length = 0;
  await page.locator('button', { hasText: 'Auto-assign rooms evenly' }).click();
  await page.waitForTimeout(700);
  const checkHead = await page.locator('.section-label', { hasText: 'Check these assignments' }).textContent();
  contains('auto-assigned rooms all land in the check list', checkHead, 'Check these assignments (3)');
  const status2 = await page.locator('.section-label', { hasText: 'Rooms to clean today' }).first()
    .evaluate((e) => e.nextElementSibling.textContent);
  contains('status line flags how many need checking', status2, '3 to check');
  const pendingChips = await page.locator('.section-label', { hasText: 'Rooms to clean today' }).first()
    .evaluate((e) => Array.from(e.nextElementSibling.nextElementSibling.children).map((c) => c.textContent.trim()));
  check('unchecked suggestions are marked with ?', pendingChips.filter((c) => c.endsWith('?')).length === 3, 'chips: ' + JSON.stringify(pendingChips));

  // "Yes" signs one off.
  const firstRow = page.locator('.su-card').filter({ hasText: '→' }).first();
  writes.length = 0;
  await firstRow.locator('button', { hasText: 'Yes' }).click();
  await page.waitForTimeout(700);
  const afterYes = await page.locator('.section-label', { hasText: 'Check these assignments' }).textContent();
  contains('confirming removes it from the check list', afterYes, 'Check these assignments (2)');
  const wYes = writes[writes.length - 1];
  const confirmedIds = wYes ? Object.keys(wYes.data.assignConfirmed || {}) : [];
  check('the sign-off is persisted, dated today', confirmedIds.length >= 1 && Object.values(wYes.data.assignConfirmed).every((d) => d === TODAY), JSON.stringify(wYes && wYes.data.assignConfirmed));

  // "No" opens the picker.
  console.log('\n\x1b[1mAUTO-ASSIGN — "No" reassigns via the picker\x1b[0m');
  const row2 = page.locator('.su-card').filter({ hasText: '→' }).first();
  // .su-card > div(info) > [room number, "→ cleaner"] — so nth(1) is the room number
  const room2 = (await row2.locator('div').nth(1).textContent()).replace(/[🌅⭐]\s*/g, '').trim();
  await row2.locator('button', { hasText: 'No' }).click();
  await page.waitForSelector('#assignPicker');
  const pickTitle = await page.locator('#assignPicker .modal-title').textContent();
  eq('picker names the room', pickTitle, `Who should take ${room2}?`);
  const opts = await page.locator('#assignPicker .cover-opt').allTextContents();
  check('picker lists only clocked-in cleaners', opts.length === 2, 'options: ' + JSON.stringify(opts));
  check('picker shows each cleaner\'s current load', opts.every((o) => /\d+ rooms?/.test(o)), 'options: ' + JSON.stringify(opts));
  check('picker marks who was suggested', opts.some((o) => o.includes('suggested')), 'options: ' + JSON.stringify(opts));

  // Pick the cleaner who was NOT suggested.
  const other = await page.locator('#assignPicker .cover-opt').filter({ hasNotText: 'suggested' }).first();
  const otherName = (await other.textContent()).replace(/\d+ rooms?.*$/, '').trim();
  writes.length = 0;
  await other.click();
  await page.waitForTimeout(700);
  check('picker closes after choosing', (await page.locator('#assignPicker').count()) === 0, 'picker still open');
  const wNo = writes[writes.length - 1];
  const moved = wNo && (wNo.data.servicedUnits || []).find((u) => u.unit === room2);
  const newOwner = wNo && (wNo.data.staff || []).find((p) => p.id === (moved && moved.assignedTo));
  eq('the room moved to the cleaner you picked', newOwner && newOwner.name, otherName);
  check('a hand-picked cleaner counts as signed off', wNo && wNo.data.assignConfirmed[moved.id] === TODAY, JSON.stringify(wNo && wNo.data.assignConfirmed));
  const afterNo = await page.locator('.section-label', { hasText: 'Check these assignments' }).count();
  check('reassigning clears it from the check list too', afterNo === 0 || !(await page.locator('.section-label', { hasText: 'Check these assignments' }).textContent()).includes('(2)'), 'still showing 2 to check');

  // Re-running auto-assign must invalidate the sign-offs it overwrites.
  writes.length = 0;
  await page.locator('button', { hasText: 'Auto-assign rooms evenly' }).click();
  await page.waitForTimeout(700);
  const reRun = await page.locator('.section-label', { hasText: 'Check these assignments' }).textContent();
  contains('re-running auto-assign puts everything back up for checking', reRun, 'Check these assignments (3)');

  // ---------------------------------------------------------------- ALL ROOMS
  console.log('\n\x1b[1mALL ROOMS — per-room + bulk frequency flip\x1b[0m');
  await page.locator('.nav button', { hasText: 'More' }).click();
  await page.locator('.su-unit', { hasText: 'All Rooms' }).click();
  await page.waitForSelector('text=/Set all:/');

  const bulkLine = await page.locator('text=/^Now: /').first().textContent();
  contains('group breakdown counts the daily rooms', bulkLine, '4 Daily');
  contains('group breakdown exposes the odd one out', bulkLine, '1 Every other day');

  // Per-room flip: 103 (eod) -> weekly, on its own card.
  writes.length = 0;
  const card103 = page.locator('.su-card').filter({ hasText: '103' }).first();
  await card103.locator('button', { hasText: 'Weekly' }).first().click();
  await page.waitForTimeout(700);
  const w103 = writes[writes.length - 1];
  const saved103 = w103 && (w103.data.servicedUnits || []).find((u) => u.id === 'u103');
  eq('single-room flip saves the new schedule', saved103 && saved103.freq, 'weekly');

  // Bulk flip: set the whole Airbnb group to Daily.
  writes.length = 0;
  await page.locator('text=/^Now: /').first().locator('..').locator('button', { hasText: 'Daily' }).first().click();
  await page.waitForSelector('#confirmModal');
  const confirmTitle = await page.locator('#confirmModal .modal-title').textContent();
  contains('confirm counts only the rooms that actually change', confirmTitle, 'Set 1 room to Daily?');
  const okBtn = page.locator('#confirmModal .modal-btns button').last();
  eq('confirm button is labelled for the action, not "Remove"', await okBtn.textContent(), 'Set Daily');
  eq('a schedule change is not styled as destructive', await okBtn.getAttribute('class'), 'modal-confirm');
  await okBtn.click();
  await page.waitForTimeout(700);
  const wBulk = writes[writes.length - 1];
  const airbnbFreqs = wBulk ? (wBulk.data.servicedUnits || []).filter((u) => u.type === 'airbnb').map((u) => u.freq) : [];
  check('every Airbnb room is now daily', airbnbFreqs.length === 5 && airbnbFreqs.every((f) => f === 'daily'), 'freqs: ' + JSON.stringify(airbnbFreqs));
  const officeFreq = wBulk && (wBulk.data.servicedUnits || []).find((u) => u.id === 'u201');
  eq('the office group was left alone', officeFreq && officeFreq.freq, 'weekly');

  // Bulk "mark all cleaned today".
  writes.length = 0;
  const markLine = page.locator('text=/cleaned today · Mark all:/').first();
  contains('group shows how many are already cleaned', await markLine.textContent(), 'of 5 cleaned today');
  await markLine.locator('..').locator('button', { hasText: 'Cleaned today' }).click();
  await page.waitForSelector('#confirmModal');
  contains('confirm skips rooms already marked', await page.locator('#confirmModal .modal-title').textContent(), 'Mark 4 rooms cleaned today?');
  await page.locator('#confirmModal .modal-btns button').last().click();
  await page.waitForTimeout(700);
  const wMark = writes[writes.length - 1];
  const airbnbCleaned = wMark ? (wMark.data.servicedUnits || []).filter((u) => u.type === 'airbnb') : [];
  check('every room in the group is dated today', airbnbCleaned.length === 5 && airbnbCleaned.every((u) => u.lastCleaned === TODAY), JSON.stringify(airbnbCleaned.map((u) => [u.unit, u.lastCleaned])));
  const officeUntouched = wMark && (wMark.data.servicedUnits || []).find((u) => u.id === 'u201');
  eq('the office group was not marked', officeUntouched && officeUntouched.lastCleaned, YESTERDAY);

  // Every-other-day rooms cleaned together pile onto one morning. Set the office
  // group up that way, then prove "Even out the days" splits them.
  writes.length = 0;
  await page.locator('.nav button', { hasText: 'Roll Call' }).click();
  await page.locator('.nav button', { hasText: 'More' }).click();
  await page.locator('.su-unit', { hasText: 'All Rooms' }).click();
  await page.waitForSelector('text=/Set all:/');
  const airbnbBulk = page.locator('text=/^Now: /').first().locator('..');
  await airbnbBulk.locator('button', { hasText: 'Every other day' }).click();
  await page.waitForSelector('#confirmModal');
  await page.locator('#confirmModal .modal-btns button').last().click();
  await page.waitForTimeout(700);
  const warn = await page.locator('text=/land on|on one day vs/').first().textContent();
  contains('a whole group landing on one day is flagged', warn, 'all 5 land on');
  await page.locator('button', { hasText: 'Even out the days' }).first().click();
  await page.waitForSelector('#confirmModal');
  const balTitle = await page.locator('#confirmModal .modal-title').textContent();
  contains('confirm says how many rooms move', balTitle, 'Spread 2 rooms onto later days?');
  const balSub = await page.locator('#confirmModal .modal-sub').textContent();
  contains('confirm promises no room is cleaned early', balSub, 'No room is cleaned sooner');
  await page.locator('#confirmModal .modal-btns button').last().click();
  await page.waitForTimeout(700);
  const wBal = writes[writes.length - 1];
  const eod = wBal ? (wBal.data.servicedUnits || []).filter((u) => u.type === 'airbnb') : [];
  const dueDates = {};
  eod.forEach((u) => {
    // The spread is a one-off shift tied to the clean it came from, not a faked
    // lastCleaned — so next-due is lastCleaned + cadence + shift.
    const shift = (u.cycleShiftFrom && u.cycleShiftFrom === u.lastCleaned) ? (u.cycleShift || 0) : 0;
    const d = new Date(u.lastCleaned + 'T00:00:00'); d.setDate(d.getDate() + 2 + shift);
    const k = d.toLocaleDateString('en-CA'); dueDates[k] = (dueDates[k] || 0) + 1;
  });
  check('no room has a lastCleaned date in the future', eod.every((u) => u.lastCleaned <= TODAY), 'dates: ' + JSON.stringify(eod.map((u) => [u.unit, u.lastCleaned])));
  const spread = Object.keys(dueDates).sort();
  check('rooms now fall on more than one day', spread.length > 1, 'due dates: ' + JSON.stringify(dueDates));
  const counts = spread.map((d) => dueDates[d]);
  check('the split is even, not lopsided', Math.max(...counts) - Math.min(...counts) <= 1, 'counts: ' + JSON.stringify(dueDates));

  // Put the group back on daily for the assertions that follow.
  await airbnbBulk.locator('button', { hasText: 'Daily' }).first().click();
  await page.waitForSelector('#confirmModal');
  await page.locator('#confirmModal .modal-btns button').last().click();
  await page.waitForTimeout(700);

  // Flipping 103 to daily must put it on today's list.
  await page.locator('.nav button', { hasText: 'Roll Call' }).click();
  await page.waitForSelector('text=/Rooms to clean today/');
  const newHeading = await page.locator('.section-label', { hasText: 'Rooms to clean today' }).first().textContent();
  contains('newly-daily room joins today\'s list', newHeading, 'Rooms to clean today (5)');

  // ----------------------------------------------------------------- SAFETY
  console.log('\n\x1b[1mSAFETY + HEALTH\x1b[0m');
  check('no request reached an unplanned Supabase endpoint', unexpected.length === 0, unexpected.join('\n       '));
  const realErrors = consoleErrors.filter((e) => !/websocket|realtime|WebSocket/i.test(e));
  check('no page errors', realErrors.length === 0, realErrors.slice(0, 5).join('\n       '));

  await browser.close();
  srv.close();
  report();
})().catch((e) => { console.error('\n\x1b[31mTEST CRASHED\x1b[0m', e); process.exit(1); });

function report() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n\x1b[1m${results.length - failed.length}/${results.length} passed\x1b[0m`);
  if (failed.length) { console.log('\x1b[31mFailures:\x1b[0m\n' + failed.map((f) => '  · ' + f.name).join('\n')); process.exit(1); }
  process.exit(0);
}
