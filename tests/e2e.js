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
const TWO_DAYS_AGO = key(new Date(Date.now() - 2 * 864e5));   // a day nobody badged in for

// --- fixtures ---------------------------------------------------------------
// Three cleaners; Hodan never badges in, so she must not appear on the roll call.
const STAFF = [
  { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, floors: [] },
  // Fatima owns floor 1, so auto-assign should keep floor-1 rooms with her.
  { id: 'p2', name: 'Fatima Ali', crew: 'Team A', isCleaner: true, floors: [1] },
  { id: 'p3', name: 'Hodan Omar', crew: 'Team B', isCleaner: true, isLeader: true, floors: [] },
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

// Team B owns floor 2; Hodan leads it. Fatima owns floor 1 personally, so the two
// kinds of ownership can be told apart.
const TEAMS = [
  { name: 'Team A', color: '#0284c7', floors: [] },
  { name: 'Team B', color: '#15803d', floors: [2] },
];

const APP_STATE = {
  servicedUnits: UNITS,
  staff: STAFF,
  teams: TEAMS,
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
// Yesterday's crew is deliberately nobody from today's: Hodan worked last night and
// never badges in today. Anything recorded against yesterday must carry her name,
// not whoever today's roll call happens to have assigned.
const HIK_EVENTS = [
  { person_name: 'Amina Yusuf', person_code: '1001', event_time: TODAY + ' 06:12:00' },
  { person_name: 'Fatima Ali', person_code: '1002', event_time: TODAY + ' 06:40:00' },
  { person_name: 'Hodan Omar', person_code: '1003', event_time: YESTERDAY + ' 19:05:00' },
];

const SESSION = {
  access_token: 'test-access-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 4102444800, // year 2100 — never triggers a refresh
  refresh_token: 'test-refresh-token',
  user: { id: 'test-user', aud: 'authenticated', role: 'authenticated', email: 'test@example.com' },
};

// The app asks for one day at a time (event_time=like.YYYY-MM-DD*). Answering with
// every day's scans would let a broken day filter still pass.
function eventsForRequestedDay(url) {
  const m = decodeURIComponent(url).match(/event_time=like\.(\d{4}-\d{2}-\d{2})/);
  return m ? HIK_EVENTS.filter((e) => e.event_time.startsWith(m[1])) : HIK_EVENTS;
}

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
  let failWrites = false;   // flip on to simulate the server being unreachable
  const unexpected = [];    // any Supabase path we didn't plan for
  const logged = [];        // every cleaning_log row the app tried to write
  let logPosts = 0;         // how many separate inserts those rows arrived in

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
      if (failWrites) return json({ message: 'network is down' }, 503);
      writes.push(JSON.parse(req.postData() || '{}'));
      return json([{}], 201);
    }
    if (url.includes('/rest/v1/hik_events')) {
      // Honour the day filter the app asks for — recording a past day reads a
      // different day's badge-ins than the roll call is showing.
      if (method === 'GET') return json(eventsForRequestedDay(url));
      return json([{}], 201);
    }
    if (url.includes('/rest/v1/cleaning_log')) {
      if (method === 'POST') {
        // A backdated night is written as one insert of many rows.
        const body = JSON.parse(req.postData() || '{}');
        const rows = Array.isArray(body) ? body : [body];
        logPosts += 1;
        rows.forEach((r) => logged.push(r));
        return json(rows.map((_, i) => ({ id: 'log' + (logged.length - rows.length + i + 1) })), 201);
      }
      return json([]);
    }

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
  await page.waitForSelector('.header', { timeout: 15000 }).catch(() => {});

  // Auto-assign asks before discarding assignments that already exist. Accept it
  // when it appears; a fresh morning with nothing handed out won't show one.
  // ONE SCREEN, AND A MENU FOR EVERYTHING ELSE. The tab bar this test was written
  // against is gone: the app opens on the board, and Rooms, the morning set-up, the
  // team, the history and the settings all live behind the ☰ in the corner. Rooms
  // carries its own All / Airbnb / Offices / Buildings segments, so a screen in there
  // is named by both. smoke-nav owns the chrome itself — it asserts the tab bar is
  // gone and walks the menu; this test only needs to get to a screen and stay honest
  // about what happens on it.
  const MENU = { rollcall: 'Morning set-up', calendar: 'Calendar', plan: 'Plan a day',
    rooms: 'Rooms & schedules', building: 'Floors & common areas', exterior: 'Exterior',
    team: 'Team', history: 'Cleaning history', tonight: 'Tonight\u2019s round',
    settings: 'Settings' };
  const SEG = { all: 0, airbnb: 1, office: 2, building: 3 };
  const go = async (tab, seg) => {
    await page.locator('.tb-btn', { hasText: '☰' }).first().click();
    await page.waitForTimeout(350);
    // The sheet is the only thing on z-index 900, and its labels repeat words that are
    // on the board behind it — so pick inside the sheet, not anywhere on the page.
    await page.locator('[style*="z-index:900"] button', { hasText: MENU[tab] }).first().click();
    await page.waitForTimeout(900);
    if (seg) { await page.locator('.segbtn').nth(SEG[seg]).click(); await page.waitForTimeout(900); }
  };

  const autoAssign = async () => {
    await page.locator('button', { hasText: "Auto-assign today's rooms evenly" }).click();
    if (await page.locator('#confirmModal').count()) {
      await page.locator('#confirmModal .modal-btns button').last().click();
    }
    await page.waitForTimeout(1800);
  };

  console.log('\n\x1b[1mBOOT\x1b[0m');
  const loggedIn = await page.locator('.header').count();
  check('app boots past the login screen', loggedIn > 0, 'login screen still showing — session stub failed');
  if (!loggedIn) { await browser.close(); srv.close(); report(); return; }

  // Regression: a device with NO localStorage cache (incognito, cleared cache, new
  // phone) used to land on the dead tab 'cleaning' and render a blank screen. The tab
  // it lands on is the board now — the app opens on the work rather than on a hub.
  eq('fresh device with no cache lands on a real tab', await page.evaluate(() => state.tab), 'board');
  check('fresh device renders a body, not a blank screen', (await page.locator('.body').count()) > 0, 'no .body rendered');

  // Roll Call is a screen you go to now, not the one you land on — the app opens on
  // the board. Everything below is about the morning set-up, so go there first.
  await go('rollcall');
  // The badge-ins land asynchronously, so the cards they build are not there the instant
  // the screen is. Wait for the crew rather than for a clock.
  await page.waitForSelector('.person-name', { timeout: 10000 }).catch(() => {});

  // An empty roll call must be distinguishable from a stale one.
  await page.waitForSelector('#lastPull');
  contains('roll call reports when attendance was last read', await page.locator('#lastPull').textContent(), 'Attendance checked');
  check('there is a manual re-check button', (await page.locator('button', { hasText: 'Check now' }).count()) > 0, 'no "Check now" button');

  // Wait for arrivals to resolve before reading the panel.
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
  await page.waitForTimeout(1800);  // debounced remote push is 1200ms
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
  await autoAssign();
  const checkHead = await page.locator('.section-label', { hasText: 'Check these assignments' }).textContent();
  contains('auto-assigned rooms all land in the check list', checkHead, 'Check these assignments (3)');
  const status2 = await page.locator('.section-label', { hasText: 'Rooms to clean today' }).first()
    .evaluate((e) => e.nextElementSibling.textContent);
  contains('status line flags how many need checking', status2, '3 to check');
  // Floors are how the building is already divided up, and a cleaner working one
  // floor walks far less than one chasing rooms across eleven. Room 104 has no
  // usual cleaner and isn't prefers-early, so it falls to the floor-1 owner.
  const w104 = writes[writes.length - 1].data.servicedUnits.find((u) => u.id === 'u104');
  eq('a room with no usual cleaner goes to whoever owns its floor', w104 && w104.assignedTo, 'p2');
  contains('the summary says how many stayed on their own floor', await page.locator('.body').first().innerText(), 'kept on their own floor');
  const pendingChips = await page.locator('.section-label', { hasText: 'Rooms to clean today' }).first()
    .evaluate((e) => Array.from(e.nextElementSibling.nextElementSibling.children).map((c) => c.textContent.trim()));
  check('unchecked suggestions are marked with ?', pendingChips.filter((c) => c.endsWith('?')).length === 3, 'chips: ' + JSON.stringify(pendingChips));

  // "Yes" signs one off.
  const firstRow = page.locator('.su-card').filter({ hasText: '→' }).first();
  writes.length = 0;
  await firstRow.locator('button', { hasText: 'Yes' }).click();
  await page.waitForTimeout(1800);
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
  await page.waitForTimeout(1800);
  check('picker closes after choosing', (await page.locator('#assignPicker').count()) === 0, 'picker still open');
  const wNo = writes[writes.length - 1];
  const moved = wNo && (wNo.data.servicedUnits || []).find((u) => u.unit === room2);
  const newOwner = wNo && (wNo.data.staff || []).find((p) => p.id === (moved && moved.assignedTo));
  eq('the room moved to the cleaner you picked', newOwner && newOwner.name, otherName);
  check('a hand-picked cleaner counts as signed off', wNo && wNo.data.assignConfirmed[moved.id] === TODAY, JSON.stringify(wNo && wNo.data.assignConfirmed));
  const afterNo = await page.locator('.section-label', { hasText: 'Check these assignments' }).count();
  check('reassigning clears it from the check list too', afterNo === 0 || !(await page.locator('.section-label', { hasText: 'Check these assignments' }).textContent()).includes('(2)'), 'still showing 2 to check');

  // Auto-assign is one mis-tap from the room list, so it asks first — but only
  // when there is something to lose.
  console.log('\n\x1b[1mAUTO-ASSIGN — asks before discarding existing work\x1b[0m');
  await page.locator('button', { hasText: "Auto-assign today's rooms evenly" }).click();
  await page.waitForSelector('#confirmModal');
  contains('confirm counts every room it will reshuffle', await page.locator('#confirmModal .modal-title').textContent(), 'Reassign all 3 rooms?');
  const reSub = await page.locator('#confirmModal .modal-sub').textContent();
  contains('confirm says how many are already handed out', reSub, 'are already handed out');
  contains('confirm reassures that permanent cleaners are kept', reSub, 'permanent cleaner stay');
  contains('confirm mentions it can be undone', reSub, 'undo');
  await page.locator('#confirmModal .modal-skip').click();
  const kept = writes.length;
  await page.waitForTimeout(1800);
  check('cancelling changes nothing', writes.length === kept, 'a write happened after cancel');

  // Auto-assign discards a morning of manual work and sits one mis-tap away.
  const beforeUndo = writes[writes.length - 1].data.servicedUnits
    .reduce((m, u) => { m[u.id] = u.assignedTo || null; return m; }, {});
  writes.length = 0;
  await autoAssign();
  const shuffled = writes[writes.length - 1].data.servicedUnits
    .reduce((m, u) => { m[u.id] = u.assignedTo || null; return m; }, {});
  const snap = writes[writes.length - 1].data.lastAutoAssign;
  check('auto-assign snapshots what it is about to overwrite', snap && Object.keys(snap.who || {}).length === Object.keys(shuffled).filter((id) => shuffled[id]).length, 'snapshot: ' + JSON.stringify(snap && snap.who));
  eq('the snapshot holds the pre-shuffle owners, not the new ones', JSON.stringify(Object.keys(snap.who).reduce((m, k) => { m[k] = beforeUndo[k]; return m; }, {})), JSON.stringify(snap.who));
  writes.length = 0;
  await page.locator('button', { hasText: 'Undo auto-assign' }).click();
  await page.waitForTimeout(1800);
  const restored = writes[writes.length - 1].data.servicedUnits
    .reduce((m, u) => { m[u.id] = u.assignedTo || null; return m; }, {});
  eq('undo puts every room back exactly as it was', JSON.stringify(restored), JSON.stringify(beforeUndo));
  check('the undo button goes away once used', (await page.locator('button', { hasText: 'Undo auto-assign' }).count()) === 0, 'undo still offered');

  // Re-running auto-assign must invalidate the sign-offs it overwrites.
  writes.length = 0;
  await autoAssign();
  const reRun = await page.locator('.section-label', { hasText: 'Check these assignments' }).textContent();
  contains('re-running auto-assign puts everything back up for checking', reRun, 'Check these assignments (3)');

  // ---------------------------------------------------------------- ALL ROOMS
  console.log('\n\x1b[1mALL ROOMS — per-room + bulk frequency flip\x1b[0m');
  await go('rooms', 'all');
  await page.waitForSelector('text=/Set all:/');

  const bulkLine = await page.locator('text=/^Now: /').first().textContent();
  contains('group breakdown counts the daily rooms', bulkLine, '4 Daily');
  contains('group breakdown exposes the odd one out', bulkLine, '1 Every other day');

  // Per-room flip: 103 (eod) -> weekly, on its own card.
  writes.length = 0;
  const card103 = page.locator('.su-card').filter({ hasText: '103' }).first();
  await card103.locator('button', { hasText: 'Weekly' }).first().click();
  await page.waitForTimeout(1800);
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
  await page.waitForTimeout(1800);
  const wBulk = writes[writes.length - 1];
  const airbnbFreqs = wBulk ? (wBulk.data.servicedUnits || []).filter((u) => u.type === 'airbnb').map((u) => u.freq) : [];
  check('every Airbnb room is now daily', airbnbFreqs.length === 5 && airbnbFreqs.every((f) => f === 'daily'), 'freqs: ' + JSON.stringify(airbnbFreqs));
  const officeFreq = wBulk && (wBulk.data.servicedUnits || []).find((u) => u.id === 'u201');
  eq('the office group was left alone', officeFreq && officeFreq.freq, 'weekly');

  // ------------------------------------------ LAST CLEANED IS DURABLE
  // The history log only holds the newest 1000 rows for the whole building, so a
  // room that is cleaned rarely falls out of it. If that log is the only record,
  // the room's last-cleaned line vanishes and it goes back to looking never-cleaned.
  console.log('\n\x1b[1mLAST CLEANED — stamped on the room, not just the log\x1b[0m');
  await go('rooms', 'airbnb');
  await page.waitForTimeout(1800);
  const room101 = page.locator('.su-card').filter({ has: page.locator('.su-unit', { hasText: '101' }) }).first();
  writes.length = 0;
  await room101.locator('button.su-mark').first().click();
  await page.waitForTimeout(1800);
  const wTick = writes[writes.length - 1];
  const u101 = wTick && (wTick.data.servicedUnits || []).find((u) => u.id === 'u101');
  eq('ticking a room stamps its own last-cleaned date', u101 && u101.lastCleaned, TODAY);
  check('and records who it is credited to', Boolean(u101 && u101.lastCleanedByName), JSON.stringify(u101 && { by: u101.lastCleanedBy, name: u101.lastCleanedByName }));

  // Un-ticking must not leave today's date behind as the last clean.
  writes.length = 0;
  await page.locator('.su-card').filter({ has: page.locator('.su-unit', { hasText: '101' }) }).first()
    .locator('button.su-mark').first().click();
  await page.waitForTimeout(1800);
  const wUntick = writes[writes.length - 1];
  const u101back = wUntick && (wUntick.data.servicedUnits || []).find((u) => u.id === 'u101');
  eq('un-ticking restores the previous date', u101back && u101back.lastCleaned, YESTERDAY);
  check('and clears the name it had stamped', !u101back || !u101back.lastCleanedByName, JSON.stringify(u101back && u101back.lastCleanedByName));

  // A room nobody has ever recorded says so, rather than showing nothing at all.
  const room104 = page.locator('.su-card').filter({ has: page.locator('.su-unit', { hasText: '104' }) }).first();
  contains('a never-cleaned room says so instead of hiding the line', await room104.textContent(), 'no record yet');

  // Back to All Rooms for the bulk tests that follow.
  await go('rooms', 'all');
  await page.waitForSelector('text=/Set all:/');

  // Bulk "mark all cleaned today".
  writes.length = 0;
  logged.length = 0;
  const markLine = page.locator('text=/cleaned today · Mark all:/').first();
  contains('group shows how many are already cleaned', await markLine.textContent(), 'of 5 cleaned today');
  await markLine.locator('..').locator('button', { hasText: 'Cleaned today' }).click();
  await page.waitForSelector('#confirmModal');
  contains('confirm skips rooms already marked', await page.locator('#confirmModal .modal-title').textContent(), 'Mark 4 rooms cleaned today?');
  await page.locator('#confirmModal .modal-btns button').last().click();
  await page.waitForTimeout(1800);
  const wMark = writes[writes.length - 1];
  const airbnbCleaned = wMark ? (wMark.data.servicedUnits || []).filter((u) => u.type === 'airbnb') : [];
  check('every room in the group is dated today', airbnbCleaned.length === 5 && airbnbCleaned.every((u) => u.lastCleaned === TODAY), JSON.stringify(airbnbCleaned.map((u) => [u.unit, u.lastCleaned])));
  const officeUntouched = wMark && (wMark.data.servicedUnits || []).find((u) => u.id === 'u201');
  eq('the office group was not marked', officeUntouched && officeUntouched.lastCleaned, YESTERDAY);
  // Marking rooms cleaned must reach Cleaning History, not just the schedule —
  // an office using these buttons instead of ticking rooms off had an empty log.
  check('marking rooms cleaned writes them to history', logged.length === 4, logged.length + ' history rows written');
  check('history rows carry the room and who cleaned it', logged.every((l) => l.unit_label && l.cleaner_name), JSON.stringify(logged.map((l) => [l.unit_label, l.cleaner_name])));
  check('history is dated the day of the clean', logged.every((l) => String(l.cleaned_at).slice(0, 10) === TODAY), JSON.stringify(logged.map((l) => l.cleaned_at)));

  // ------------------------------------------------ A PAST DAY
  // Last night's work is entered the next morning. It must land on last night's
  // date and carry last night's crew — today's assignment is the wrong answer.
  console.log('\n\x1b[1mA PAST DAY — entered the morning after\x1b[0m');
  writes.length = 0;
  logged.length = 0;
  await page.locator('text=/cleaned today · Mark all:/').first().locator('..')
    .locator('button', { hasText: 'A past day' }).click();
  const sheet = page.locator('.modal-overlay').last();
  await sheet.locator('.modal-title', { hasText: 'Record a past day' }).waitFor();
  await page.waitForTimeout(1800);            // the chosen day's badge-ins are fetched
  const crewLine = await sheet.locator('text=/\\d+ badged in —/').first().textContent();
  contains('the sheet reads the chosen day, not this morning', crewLine, 'Hodan');
  check('today\'s crew is not offered for last night', !/Amina|Fatima/.test(crewLine), crewLine);
  const picked = await sheet.locator('select').evaluateAll((els) => els.map((e) => e.value));
  check('each room is pre-named from that day\'s badge-ins', picked.length === 5 && picked.every((v) => v === 'p3'), JSON.stringify(picked));
  eq('the group arrives ticked', (await sheet.locator('.modal-confirm').textContent()).trim(), 'Log 5 cleanings');

  // A day nobody badged in for cannot be silently credited to "Office".
  await sheet.locator('input[type=date]').fill(TWO_DAYS_AGO);
  await page.waitForTimeout(1800);
  contains('a day with no badge-ins says so', await sheet.textContent(), 'Nobody badged in');
  await sheet.locator('button', { hasText: 'Tick all' }).click();
  await sheet.locator('.modal-confirm').click();
  await page.waitForTimeout(1800);
  contains('an unnamed room is refused, not credited to nobody', await sheet.textContent(), 'still need a name');
  check('nothing is written until every room has a name', logged.length === 0, logged.length + ' rows written');

  // Back to last night, and record it.
  await sheet.locator('button', { hasText: 'Yesterday' }).click();
  await page.waitForTimeout(1800);
  await sheet.locator('button', { hasText: 'Tick all' }).click();
  writes.length = 0;
  logged.length = 0;
  await sheet.locator('.modal-confirm').click();
  await page.waitForTimeout(1800);
  check('the night is written in one go', logged.length === 5, logged.length + ' rows written');
  check('every row carries the crew who badged in that night', logged.every((l) => l.cleaner_name === 'Hodan Omar'), JSON.stringify(logged.map((l) => l.cleaner_name)));
  check('every row is dated that night', logged.every((l) => String(l.cleaned_at).slice(0, 10) === YESTERDAY), JSON.stringify(logged.map((l) => l.cleaned_at)));
  const wPast = writes[writes.length - 1];
  const airbnbAfter = wPast ? (wPast.data.servicedUnits || []).filter((u) => u.type === 'airbnb') : [];
  // These rooms were also cleaned today. Recording an older night must not pull
  // their schedule back and make them look due again.
  check('an older night never drags the schedule backwards', airbnbAfter.length === 5 && airbnbAfter.every((u) => u.lastCleaned === TODAY), JSON.stringify(airbnbAfter.map((u) => [u.unit, u.lastCleaned])));
  contains('recording a day lands you in History to see it', await page.locator('.header').first().textContent(), 'Cleaning History');
  check('the sheet closes once the night is saved', (await page.locator('.modal-overlay').count()) === 0, 'sheet still open');

  // Every-other-day rooms cleaned together pile onto one morning. Set the office
  // group up that way, then prove "Even out the days" splits them.
  writes.length = 0;
  await go('rollcall');
  await go('rooms', 'all');
  await page.waitForSelector('text=/Set all:/');
  const airbnbBulk = page.locator('text=/^Now: /').first().locator('..');
  await airbnbBulk.locator('button', { hasText: 'Every other day' }).click();
  await page.waitForSelector('#confirmModal');
  await page.locator('#confirmModal .modal-btns button').last().click();
  await page.waitForTimeout(1800);
  const warn = await page.locator('text=/land on|on one day vs/').first().textContent();
  contains('a whole group landing on one day is flagged', warn, 'all 5 land on');
  // "Even out the days" is the leveller now — it applies straight away and reports
  // what it did, rather than proposing a set of one-day delays.
  await page.locator('button', { hasText: 'Even out the days' }).first().click();
  await page.waitForTimeout(1800);
  const wBal = writes[writes.length - 1];
  const eod = wBal ? (wBal.data.servicedUnits || []).filter((u) => u.type === 'airbnb') : [];
  check('no room has a lastCleaned date in the future', eod.every((u) => !u.lastCleaned || u.lastCleaned <= TODAY),
    'dates: ' + JSON.stringify(eod.map((u) => [u.unit, u.lastCleaned])));
  check('the rooms are split across the cycle, not left on one day',
    eod.some((u) => u.alsoCleanOn), 'nothing was spread: ' + JSON.stringify(eod.map((u) => [u.unit, u.alsoCleanOn])));
  check('and none of them is made to wait longer than its frequency',
    eod.every((u) => !u.holdUntil), 'a room was held back: ' + JSON.stringify(eod.filter((u) => u.holdUntil).map((u) => u.unit)));
  const spreadDays = [...new Set(eod.map((u) => u.alsoCleanOn).filter(Boolean))];
  check('the extra cleans land on a day ahead, never today or the past',
    spreadDays.every((d) => d > TODAY), 'landed on: ' + JSON.stringify(spreadDays));

  // Put the group back on daily for the assertions that follow.
  await airbnbBulk.locator('button', { hasText: 'Daily' }).first().click();
  await page.waitForSelector('#confirmModal');
  await page.locator('#confirmModal .modal-btns button').last().click();
  await page.waitForTimeout(1800);

  // Flipping 103 to daily must put it on today's list.
  await go('rollcall');
  await page.waitForSelector('text=/Rooms to clean today/');
  const newHeading = await page.locator('.section-label', { hasText: 'Rooms to clean today' }).first().textContent();
  contains('newly-daily room joins today\'s list', newHeading, 'Rooms to clean today (5)');

  // ------------------------------------------------------- TEAM-OWNED ZONES
  console.log('\n\x1b[1mTEAMS — a team owns a zone, the leader answers for it\x1b[0m');
  await go('settings');
  await page.waitForSelector('#newTeam');
  const teamBox = page.locator('.addbox').filter({ hasText: 'Zone floors' }).first();
  contains('a team shows the zone it owns', await teamBox.innerText(), 'Zone floors');
  contains('a team names its leader', await teamBox.innerText(), '★ Hodan Omar leads this team');
  contains('a team without a leader says so', await teamBox.innerText(), 'No leader');

  // Hand floor 2 to Team A, whose members actually clocked in.
  const zoneInputs = teamBox.locator('input[placeholder="e.g. 10, 11"]');
  await zoneInputs.first().fill('2');
  await zoneInputs.first().dispatchEvent('change');
  await page.waitForTimeout(1800);

  // Make the floor-2 room due so auto-assign has something to route.
  await go('rooms', 'all');
  await page.waitForSelector('text=/Set all:/');
  await page.locator('.su-card').filter({ hasText: '201' }).first().locator('button', { hasText: 'Daily' }).first().click();
  await page.waitForTimeout(1800);

  await go('rollcall');
  await page.waitForSelector('text=/Rooms to clean today/');
  writes.length = 0;
  await autoAssign();
  const w201 = writes[writes.length - 1].data.servicedUnits.find((u) => u.id === 'u201');
  check('a room in a team\'s zone goes to a member of that team', ['p1', 'p2'].includes(w201 && w201.assignedTo), '201 went to ' + (w201 && w201.assignedTo));
  contains('the summary reports work kept inside the zone', await page.locator('.body').first().innerText(), "kept in their team's zone");

  // -------------------------------------------------- TRAINEES / CLEARANCES
  console.log('\n\x1b[1mCLEARANCES — trainees kept off rooms they cannot take\x1b[0m');
  await go('team');
  await page.waitForTimeout(300);
  // Amina is a trainee: clear her off offices.
  const aminaCard = page.locator('.person').filter({ hasText: 'Amina Yusuf' }).first();
  await aminaCard.locator('.su-edit').click();
  await page.waitForSelector('text=/Cleared to clean/');
  const editing = page.locator('.person').filter({ hasText: 'Cleared to clean' }).first();
  await editing.locator('button', { hasText: 'Office' }).click();
  await page.waitForTimeout(1800);
  const wClear = writes[writes.length - 1].data.staff.find((p) => p.id === 'p1');
  check('clearing someone off a room type is saved', wClear && Array.isArray(wClear.canClean) && !wClear.canClean.includes('office'), 'canClean: ' + JSON.stringify(wClear && wClear.canClean));

  await go('rollcall');
  await page.waitForSelector('text=/Rooms to clean today/');
  writes.length = 0;
  await autoAssign();
  const office = writes[writes.length - 1].data.servicedUnits.filter((u) => u.type === 'office' && u.assignedTo);
  check('an office room never lands on someone not cleared for it', office.every((u) => u.assignedTo !== 'p1'), 'office rooms: ' + JSON.stringify(office.map((u) => [u.unit, u.assignedTo])));

  // ------------------------------------------------ ROLL CALL ROOM FILTERING
  console.log('\n\x1b[1mROLL CALL — only the kinds of room it is meant to cover\x1b[0m');
  await go('settings');
  await page.waitForSelector('text=/Roll Call covers/');
  const rcBox = page.locator('.addbox').filter({ hasText: 'Kinds of room' }).first();
  await rcBox.locator('button', { hasText: 'Airbnb' }).click();
  await page.waitForTimeout(1800);
  await go('rollcall');
  await page.waitForSelector('text=/Rooms to clean today/');
  const chipsNow = await page.locator('.section-label', { hasText: 'Rooms to clean today' }).first()
    .evaluate((e) => Array.from(e.nextElementSibling.nextElementSibling.children).map((c) => c.textContent.trim()));
  check('switching a kind off removes it from Roll Call', !chipsNow.some((c) => /1\d\d/.test(c)), 'chips: ' + JSON.stringify(chipsNow));
  // Off the board is not enough — it must not be offered room-by-room either.
  const offered = await page.locator('.person select.area-select').first().locator('option').allTextContents();
  check('an excluded kind is not offered in the assign list', !offered.some((o) => /Room 1\d\d/.test(o)), 'offered: ' + JSON.stringify(offered));
  writes.length = 0;
  await autoAssign();
  // The snapshot lists exactly what auto-assign reshuffled, so it proves what it touched.
  const wRC = writes[writes.length - 1].data;
  const touched = Object.keys(wRC.lastAutoAssign.who)
    .map((id) => wRC.servicedUnits.find((u) => u.id === id))
    .filter(Boolean);
  check('auto-assign stops handing out the kinds Roll Call excludes', touched.length > 0 && touched.every((u) => u.type !== 'airbnb'), 'touched: ' + JSON.stringify(touched.map((u) => [u.unit, u.type])));

  // -------------------------------------- THE ROUND CROSSES MIDNIGHT
  // A room finished at 00:30 belongs to the night the crew was working, not to the
  // morning that just started. Stamping it with the calendar day gave every
  // after-midnight clean an extra day and walked every-other-day rooms off their
  // rota, so auto-assign stopped handing them out on the days they were expected.
  console.log('\n\x1b[1mAFTER MIDNIGHT — the round keeps the night it belongs to\x1b[0m');
  const clockCheck = await page.evaluate(() => {
    const RealDate = Date;
    const freeze = (iso) => {
      globalThis.Date = class extends RealDate {
        constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(iso); }
        static now() { return new RealDate(iso).getTime(); }
      };
    };
    const out = {};
    freeze('2026-08-04T00:30:00');
    out.afterMidnight = workToday();
    out.calendarAfterMidnight = todayKey();
    freeze('2026-08-04T09:00:00');
    out.morning = workToday();
    freeze('2026-08-04T02:59:00');
    out.justBeforeCutoff = workToday();
    freeze('2026-08-04T03:01:00');
    out.justAfterCutoff = workToday();
    globalThis.Date = RealDate;
    return out;
  });
  eq('a clean at 00:30 counts for the night before', clockCheck.afterMidnight, '2026-08-03');
  eq('the calendar day has already rolled over by then', clockCheck.calendarAfterMidnight, '2026-08-04');
  eq('a clean at 09:00 counts for that same day', clockCheck.morning, '2026-08-04');
  eq('the work day still holds at 02:59', clockCheck.justBeforeCutoff, '2026-08-03');
  eq('and rolls over at 03:01', clockCheck.justAfterCutoff, '2026-08-04');

  // ---------------------------------------------- TONIGHT'S ROUND
  // The crew works into the night, so "what is still outstanding" needs its own
  // screen — and it must not list work already done, nor work not yet due.
  console.log('\n\x1b[1mTONIGHT — what is still outstanding on this round\x1b[0m');
  await go('tonight');
  await page.waitForTimeout(1800);
  const tonightText = await page.locator('.body').first().textContent();
  contains('the round lists what is still outstanding', tonightText, 'to clean tonight');
  check('a room already cleaned today has dropped off', !/Unit 102/.test(tonightText), 'unit 102 was cleaned today and must not be listed');
  check('an every-other-day room not yet due is NOT listed', !/Unit 103/.test(tonightText), 'unit 103 is not due tonight');
  contains('communal areas are part of the round', tonightText, 'Interior areas');
  contains('each job says why it is due', tonightText, 'Daily');

  // -------------------------------------------------- COMMUNAL AREAS
  // The corridors and lobby are work somebody has to be given. They must reach the
  // morning allocation, and a cleaned one must leave a record like a room does.
  console.log('\n\x1b[1mCOMMUNAL AREAS — allocated in the morning, logged like a room\x1b[0m');
  await go('rollcall');
  await page.waitForSelector('text=/Communal areas/');
  const lobby = page.locator('.area-item').filter({ has: page.locator('.su-unit', { hasText: 'Main Lobby' }) }).first();
  check('Roll Call carries the communal areas', (await lobby.count()) > 0, 'no Main Lobby card on Roll Call');
  // Only people who actually clocked in can be handed an area this morning.
  const areaNames = await lobby.locator('select option').allTextContents();
  check('only people who clocked in are offered an area', !areaNames.some((o) => /Hodan/.test(o)), 'offered: ' + JSON.stringify(areaNames));

  writes.length = 0;
  await lobby.locator('select').selectOption('p1');
  await page.waitForTimeout(1800);
  const wArea = writes[writes.length - 1];
  const lobbyRow = wArea && (wArea.data.areas || []).find((a) => a.id === 'lobby');
  eq('an area handed to someone is remembered', lobbyRow && lobbyRow.assignedTo, 'p1');

  logged.length = 0;
  await page.locator('.area-item').filter({ has: page.locator('.su-unit', { hasText: 'Main Lobby' }) }).first()
    .locator('button[title="Mark clean"]').click();
  await page.waitForTimeout(1800);
  check('cleaning an area reaches History', logged.length === 1, logged.length + ' rows written');
  const aLog = logged[0] || {};
  eq('the area is logged under its own name', aLog.unit_label, 'Main Lobby');
  eq('an area id can never collide with a room id', aLog.unit_id, 'area:lobby');
  eq('the area is credited to whoever was given it', aLog.cleaner_name, 'Amina Yusuf');

  // Nine areas as nine cards buries the rest of the roll call, so a finished one
  // collapses to a chip and the section shrinks as the morning goes on.
  check('a finished area drops out of the to-do cards',
    (await page.locator('.area-item').filter({ has: page.locator('.su-unit', { hasText: 'Main Lobby' }) }).count()) === 0,
    'Main Lobby still listed as to-do after being cleaned');
  contains('a finished area is still visible, and undoable', await page.locator('.section-label', { hasText: 'Communal areas' }).first().locator('..').textContent(), 'Main Lobby · Amina ✓');

  // The Buildings tab is where building work is read; areas belong there too.
  await go('rooms', 'building');
  await page.waitForTimeout(1800);
  check('the Buildings tab shows the communal areas', (await page.locator('.section-label', { hasText: 'Communal areas' }).count()) > 0, 'no areas section on Buildings');

  // The list has to be buildable where it's read — not three taps away in Settings.
  writes.length = 0;
  await page.locator('button', { hasText: '＋ Add a communal area' }).click();
  await page.fill('#newBldArea', 'Lift Lobby');
  await page.locator('button', { hasText: '+ Add communal area' }).click();
  await page.waitForTimeout(1800);
  const wNewArea = writes[writes.length - 1];
  const addedArea = wNewArea && (wNewArea.data.areas || []).find((a) => a.label === 'Lift Lobby');
  check('a communal area can be added from the Buildings tab', !!addedArea && addedArea.kind === 'interior' && addedArea.freq === 'daily', JSON.stringify(addedArea || null));
  // The change/remove controls are folded away — one row per area — until asked for.
  const liftCard = page.locator('.area-item').filter({ has: page.locator('.su-unit', { hasText: 'Lift Lobby' }) }).first();
  check('the controls stay out of the way until wanted', (await liftCard.locator('button', { hasText: 'Rename' }).count()) === 0, 'rename control showing unasked');
  await liftCard.locator('button[title="Change or remove"]').click();
  await page.waitForTimeout(1800);
  check('an area added there can be renamed and removed there', (await page.locator('.area-item').filter({ has: page.locator('.su-unit', { hasText: 'Lift Lobby' }) }).first().locator('button', { hasText: 'Rename' }).count()) > 0, 'no rename control');
  await go('rollcall');
  await page.waitForTimeout(1800);
  check('a newly built area reaches the morning roll call', (await page.locator('.su-unit', { hasText: 'Lift Lobby' }).count()) > 0, 'not on Roll Call');

  // ------------------------------------------------------------- AUTOMATIC
  // A fresh morning should hand itself out — but never over a decision already made.
  console.log('\n\x1b[1mAUTOMATIC — hands out the morning, never overwrites you\x1b[0m');
  const auto = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const autoWrites = [];
  await auto.route(`**://${SUPA_HOST}/**`, async (route) => {
    const req = route.request(); const url = req.url(); const method = req.method();
    const json = (b, s = 200) => route.fulfill({ status: s, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(b) });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }, body: '' });
    if (url.includes('/auth/v1/')) return json(SESSION);
    if (url.includes('/rest/v1/app_state')) {
      if (method === 'GET') {
        // Nothing handed out yet, and no room already cleaned: a clean slate.
        const fresh = JSON.parse(JSON.stringify(APP_STATE));
        fresh.servicedUnits.forEach((u) => { u.assignedTo = null; u.lastCleaned = YESTERDAY; });
        const row = { data: fresh };
        return json(String(req.headers()['accept'] || '').includes('pgrst.object') ? row : [row]);
      }
      autoWrites.push(JSON.parse(req.postData() || '{}'));
      return json([{}], 201);
    }
    if (url.includes('/rest/v1/hik_events')) return json(eventsForRequestedDay(url));
    if (url.includes('/rest/v1/cleaning_log')) return json([]);
    return json([]);
  });
  await auto.addInitScript(([host, session]) => {
    localStorage.setItem('sb-' + host.split('.')[0] + '-auth-token', JSON.stringify(session));
  }, [SUPA_HOST, SESSION]);
  const ap = await auto.newPage();
  await ap.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await ap.waitForSelector('.header');
  await ap.waitForTimeout(1800);
  const autoState = autoWrites.length ? autoWrites[autoWrites.length - 1].data : null;
  const handed = autoState ? autoState.servicedUnits.filter((u) => u.assignedTo) : [];
  check('a fresh morning hands itself out with nobody pressing anything', handed.length > 0, 'nothing was assigned automatically');
  eq('it records the day it ran, so it runs once', autoState && autoState.autoAssignedOn, TODAY);
  check('everything it chose still needs a yes', (await ap.locator('.section-label', { hasText: 'Check these assignments' }).count()) > 0, 'no sign-off list');
  // Areas are hand-assigned on purpose — an even spread of rooms must not quietly
  // hand somebody the stairwells as well.
  const autoAreas = autoState ? (autoState.areas || []).filter((a) => a.assignedTo) : [];
  check('auto-assign never hands out communal areas', autoAreas.length === 0, 'assigned: ' + JSON.stringify(autoAreas.map((a) => a.label)));
  await ap.close(); await auto.close();

  console.log('\n\x1b[1mWORKS ON — not everyone is in every day\x1b[0m');
  await go('rollcall');
  await page.waitForTimeout(300);
  const rotaBase = await page.evaluate(() => {
    const p = cleaningStaff()[0];
    return { id: p.id, name: p.name, worksOn: p.worksOn === undefined ? null : p.worksOn,
      everyDayByDefault: worksToday(p) };
  });
  check('a person with no rota set works every day', rotaBase.everyDayByDefault, 'default was not every-day');
  // Take today off them, whichever weekday today happens to be.
  const rota = await page.evaluate((pid) => {
    const dow = new Date(workToday() + 'T00:00:00').getDay();
    setWorksState(pid, dow, 'off');
    const p = (state.staff || []).find((x) => x.id === pid);
    return { worksOn: p.worksOn, worksToday: worksToday(p), dow };
  }, rotaBase.id);
  check('taking a day off stores a rota', Array.isArray(rota.worksOn), 'worksOn: ' + JSON.stringify(rota.worksOn));
  eq('and that person is off today', rota.worksToday, false);
  eq('the other six days are kept', rota.worksOn.length, 6);
  const rollTxt = await page.locator('.body').first().innerText();
  contains('the roll call says who is off', rollTxt, 'off today: ' + rotaBase.name.split(' ')[0]);
  contains('and counts only the people actually expected', rollTxt, 'expected in');
  // Someone who is off did not "forget to clock in" — offering them there is how a
  // day off quietly becomes a hand-out.
  const offeredWhenOff = await page.evaluate((pid) => {
    const sel = Array.from(document.querySelectorAll('select.area-select'))
      .find((s) => (s.options[0] || {}).text && s.options[0].text.includes('forgot to clock in'));
    if (!sel) return null;
    return Array.from(sel.options).some((o) => o.value === pid);
  }, rotaBase.id);
  check('an off-duty person is not offered as a forgotten clock-in', offeredWhenOff === false || offeredWhenOff === null,
    'they were still in the add-someone list');
  // Turning up on a day off still counts — presence beats the rota.
  const present = await page.evaluate((pid) => {
    addManualArrival(pid);
    return !!hikArrivals[pid];
  }, rotaBase.id);
  check('badging in on a day off still puts them on the roll call', present, 'manual arrival did not take');
  await page.evaluate((pid) => {                       // hand the day back
    const dow = new Date(workToday() + 'T00:00:00').getDay();
    setWorksState(pid, dow, 'on'); save(); render();
  }, rotaBase.id);
  await page.waitForTimeout(300);

  console.log('\n\x1b[1mALLOCATE EVENLY — one tap, and nobody carries the morning\x1b[0m');
  const even = await page.evaluate(async () => {
    if (Array.isArray(state.rollCallTypes)) state.rollCallTypes = null;
    const crew = cleaningStaff().filter((p) => worksToday(p));
    crew.forEach((p) => addManualArrival(p.id));
    await loadHikArrivals();                         // manual arrivals only land after this
    const rooms = (state.servicedUnits || []).filter((u) => onRollCall(u));
    // Pin every room to one person: the state a board drifts into, because picking a
    // cleaner by hand also makes them that room's permanent cleaner.
    const victim = crew[0];
    rooms.forEach((u) => {
      u.lastCleaned = null; u.assignedTo = null;
      u.preferEarly = false; u.preferLate = false;
      u.usualTo = victim.id;
    });
    save();
    autoAssignRooms();
    const counts = crew.map((p) => ({ name: p.name, n: rooms.filter((u) => u.assignedTo === p.id).length }));
    const ns = counts.map((c) => c.n);
    return { crew: crew.length, rooms: rooms.length, counts,
      spread: Math.max(...ns) - Math.min(...ns), assigned: ns.reduce((a, b) => a + b, 0) };
  });
  check('there is a crew and rooms to divide', even.crew > 1 && even.rooms > even.crew, JSON.stringify(even));
  eq('every room is handed to somebody', even.assigned, even.rooms);
  check('the split is as even as the numbers allow', even.spread <= 1,
    'per cleaner: ' + JSON.stringify(even.counts.map((c) => c.name.split(' ')[0] + ':' + c.n)));
  await page.evaluate(() => {                        // let the rooms go again
    (state.servicedUnits || []).forEach((u) => { u.usualTo = null; });
    save(); render();
  });

  console.log('\n\x1b[1mSPLIT A CLUMP — same-frequency rooms that all fall due together\x1b[0m');
  const clump = await page.evaluate(() => {
    if (Array.isArray(state.rollCallTypes)) state.rollCallTypes = null;
    const rooms = (state.servicedUnits || []).filter((u) => onRollCall(u)).slice(0, 6);
    // Every one of them every-other-day, every one of them due today: the state that
    // "even out the days" cannot do anything with.
    window.__clumpUndo = rooms.map((u) => ({ id: u.id, freq: u.freq, last: u.lastCleaned }));
    // Clear any split left behind by the levelling section above, or these rooms do
    // not start as the clump this is about.
    rooms.forEach((u) => { u.freq = 'eod'; u.lastCleaned = shiftDay(todayKey(), -3);
      delete u.holdUntil; delete u.alsoCleanOn; });
    (state.servicedUnits || []).forEach((u) => { if (!rooms.includes(u)) u.paused = true; });
    save();
    const shape = () => projectDueDays(4).map((d) => d.due.length);
    const before = shape();
    const preview = staggerFrequencyGroup('eod', true);
    const heldByPreview = rooms.filter((u) => u.holdUntil || u.alsoCleanOn).length;
    const res = staggerFrequencyGroup('eod');
    const after = shape();
    const held = rooms.filter((u) => u.holdUntil).length;
    const extra = rooms.filter((u) => u.alsoCleanOn).length;
    (state.servicedUnits || []).forEach((u) => { u.paused = false; });
    return { n: rooms.length, before, after, held, extra, heldByPreview, groups: res.groups.length,
      swingBefore: Math.max(...before) - Math.min(...before),
      swingAfter: Math.max(...after) - Math.min(...after) };
  });
  check('the rooms really do all fall due together', clump.before[0] === clump.n,
    'day one carried ' + clump.before[0] + ' of ' + clump.n);
  eq('previewing it changes nothing', clump.heldByPreview, 0);
  eq('it splits them over the length of the cycle', clump.groups, 2);
  check('half of them get an extra clean rather than a delay', clump.extra > 0 && clump.extra < clump.n,
    clump.extra + ' of ' + clump.n + ' doubled up');
  eq('nothing is held back or skipped to achieve it', clump.held, 0);
  check('the week stops swinging', clump.swingAfter < clump.swingBefore,
    'swing went from ' + clump.swingBefore + ' to ' + clump.swingAfter);
  await page.evaluate(() => {                     // put the rooms back as they were
    (state.servicedUnits || []).forEach((u) => { delete u.holdUntil; delete u.alsoCleanOn; u.paused = false; });
    (window.__clumpUndo || []).forEach((o) => {
      const u = (state.servicedUnits || []).find((x) => x.id === o.id);
      if (u) { u.freq = o.freq; u.lastCleaned = o.last; }
    });
    save(); render();
  });

  console.log('\n\x1b[1mPLAN AHEAD — a future day lays itself out from the rota\x1b[0m');
  const plan = await page.evaluate(() => {
    if (Array.isArray(state.rollCallTypes)) state.rollCallTypes = null;
    const crew = cleaningStaff();
    // Put one person off tomorrow, so "rostered on" has to be doing real work.
    const day = shiftDay(todayKey(), 1);
    const dow = new Date(day + 'T00:00:00').getDay();
    const offPerson = crew[0];
    setWorksState(offPerson.id, dow, 'off');
    (state.servicedUnits || []).forEach((u) => {
      u.lastCleaned = null; u.usualTo = null; u.preferEarly = false; u.preferLate = false;
    });
    // A day nobody has opened yet: seeding it must hand the rooms out on its own.
    delete state.planSeeded[day];
    state.plans[day] = {};
    save();
    seedPlanOnce(day);
    const jobs = Object.values(getPlan(day));
    const roomJobs = jobs.filter((j) => j.kind === 'unit');
    const areaJobs = jobs.filter((j) => j.kind === 'area');
    const onDuty = crew.filter((p) => worksOnDay(p, day));
    const counts = onDuty.map((p) => roomJobs.filter((j) => j.assignedTo === p.id).length);
    return {
      day, crew: crew.length, onDuty: onDuty.length,
      offName: offPerson.name,
      rooms: roomJobs.length,
      named: roomJobs.filter((j) => j.assignedTo).length,
      toOffPerson: roomJobs.filter((j) => j.assignedTo === offPerson.id).length,
      areas: areaJobs.length,
      areasNamed: areaJobs.filter((j) => j.assignedTo).length,
      spread: counts.length ? Math.max(...counts) - Math.min(...counts) : 0,
    };
  });
  // An every-other-day room belongs on every OTHER day. Planning a week without
  // assuming the days before it get done puts it on all seven.
  const eodPlan = await page.evaluate(() => {
    const u = (state.servicedUnits || []).find((x) => onRollCall(x));
    if (!u) return null;
    u.freq = 'eod';
    u.lastCleaned = shiftDay(todayKey(), -1);        // due today, then every second day
    (state.servicedUnits || []).forEach((x) => { if (x !== u) x.paused = true; });
    save();
    const days = [];
    for (let i = 0; i < 6; i += 1) {
      const d = shiftDay(workToday(), i);
      days.push(projectDueDays(6)[i].due.some((x) => x.id === u.id));
    }
    (state.servicedUnits || []).forEach((x) => { x.paused = false; });
    save();
    return { unit: u.unit, days };
  });
  check('an every-other-day room is planned every other day', eodPlan && eodPlan.days.filter(Boolean).length === 3,
    eodPlan ? 'due on: ' + JSON.stringify(eodPlan.days) : 'no roll-call room to test with');
  // Which day it starts on depends on when it was last done; what matters is that no
  // two days in a row ever both carry it.
  check('and it alternates rather than landing on consecutive days',
    eodPlan && eodPlan.days.every((v, i) => i === 0 || v !== eodPlan.days[i - 1]),
    eodPlan ? 'pattern: ' + JSON.stringify(eodPlan.days) : '');

  check('the day has rooms on it and a crew rostered', plan.rooms > 0 && plan.onDuty > 1, JSON.stringify(plan));
  eq('somebody is genuinely off that day', plan.onDuty, plan.crew - 1);
  eq('every room is handed out without being asked', plan.named, plan.rooms);
  eq('nothing goes to the person who is off', plan.toOffPerson, 0);
  check('and it is split evenly between the rest', plan.spread <= 1, 'spread: ' + plan.spread);
  // Communal areas used to be left for the morning to decide, which in practice
  // meant nobody was named on them and they were missed. They go out with the rooms.
  check('the communal areas are handed out too', plan.areas === 0 || plan.areasNamed === plan.areas,
    plan.areasNamed + ' of ' + plan.areas + ' areas named');
  await page.evaluate((d) => {                          // give the day back
    const dow = new Date(d + 'T00:00:00').getDay();
    const p = cleaningStaff()[0];
    setWorksState(p.id, dow, 'on');
    save(); render();
  }, plan.day);

  console.log('\n\x1b[1mROTATION — nobody is stuck on the same rooms every day\x1b[0m');
  const rot = await page.evaluate(async () => {
    if (Array.isArray(state.rollCallTypes)) state.rollCallTypes = null;
    const crew = cleaningStaff().filter((p) => worksToday(p));
    crew.forEach((p) => addManualArrival(p.id));
    await loadHikArrivals();
    const rooms = (state.servicedUnits || []).filter((u) => onRollCall(u));
    rooms.forEach((u) => {
      u.lastCleaned = null; u.assignedTo = null; u.usualTo = null;
      u.preferEarly = false; u.preferLate = false; u.lastCleanedBy = null;
    });
    save();
    const counts = () => crew.map((p) => rooms.filter((u) => u.assignedTo === p.id).length);
    autoAssignRooms();
    const day1 = rooms.map((u) => u.assignedTo);
    const spread1 = Math.max(...counts()) - Math.min(...counts());
    rooms.forEach((u) => { u.lastCleanedBy = u.assignedTo; });   // they cleaned what they got
    rooms.forEach((u) => { u.assignedTo = null; delete state.assignConfirmed[u.id]; });
    autoAssignRooms();
    const day2 = rooms.map((u) => u.assignedTo);
    const spread2 = Math.max(...counts()) - Math.min(...counts());
    let repeated = 0;
    rooms.forEach((u) => { if (u.assignedTo && u.assignedTo === u.lastCleanedBy) repeated += 1; });
    return { rooms: rooms.length, crew: crew.length, repeated, spread1, spread2,
      changed: day1.filter((v, i) => v !== day2[i]).length };
  });
  check('there are rooms and a crew to rotate between', rot.rooms > rot.crew && rot.crew > 1, JSON.stringify(rot));
  check('the second day is a different hand-out', rot.changed > 0, 'nothing moved between the two days');
  // Not zero: rotation is a tie-break behind load, so with a small crew there are
  // mornings where the even split only works if somebody keeps a room. What must
  // hold is that it is far better than leaving it to chance — with this many
  // cleaners, handing out blind would repeat about half of them.
  check('most rooms change hands the next day', rot.repeated * 2 < rot.rooms,
    rot.repeated + ' of ' + rot.rooms + ' rooms went back to the same cleaner');
  // Rotation must never buy that variety with an uneven morning.
  check('and it stays even on both days', rot.spread1 <= 1 && rot.spread2 <= 1,
    'spreads: ' + rot.spread1 + ' then ' + rot.spread2);
  await page.evaluate(() => {                       // don't leak a cleaning history into the next section
    (state.servicedUnits || []).forEach((u) => { u.lastCleanedBy = null; u.assignedTo = null; });
    save(); render();
  });

  console.log('\n\x1b[1mMORNING AND AFTERNOON — asked-for times, spread across the crew\x1b[0m');
  const mix = await page.evaluate(() => {
    // An earlier section takes Airbnb off the roll call, which leaves a single room
    // to hand out — nothing to spread. Put every kind back for this one check.
    if (Array.isArray(state.rollCallTypes)) state.rollCallTypes = null;
    const crew = cleaningStaff().filter((p) => hikArrivals[p.id]);
    const rooms = (state.servicedUnits || []).filter((u) => onRollCall(u));
    rooms.forEach((u, i) => {
      u.lastCleaned = null;                       // make sure they are all due
      u.assignedTo = null; u.usualTo = null;      // and up for grabs
      u.preferEarly = i % 2 === 0;                // half morning, half afternoon
      u.preferLate = i % 2 === 1;
    });
    save();
    autoAssignRooms();
    const per = {};
    crew.forEach((p) => { per[p.id] = { name: p.name, early: 0, late: 0, total: 0 }; });
    rooms.forEach((u) => {
      const r = per[u.assignedTo];
      if (!r) return;
      r.total += 1;
      if (u.preferEarly) r.early += 1; else if (u.preferLate) r.late += 1;
    });
    const rows = Object.values(per);
    return {
      crew: crew.length,
      earlyTotal: rooms.filter((u) => u.preferEarly).length,
      lateTotal: rooms.filter((u) => u.preferLate).length,
      rows,
      earlySpread: Math.max(...rows.map((r) => r.early)) - Math.min(...rows.map((r) => r.early)),
      lateSpread: Math.max(...rows.map((r) => r.late)) - Math.min(...rows.map((r) => r.late)),
      everyoneHasBoth: rows.every((r) => r.early > 0 && r.late > 0),
      slotOrder: slotRank({ preferEarly: true }) < slotRank({}) && slotRank({}) < slotRank({ preferLate: true }),
    };
  });
  check('there are morning rooms and more than one cleaner', mix.earlyTotal > 1 && mix.crew > 1, JSON.stringify(mix));
  check('no one is left carrying all the morning rooms', mix.earlySpread <= 1,
    'morning rooms per cleaner: ' + JSON.stringify(mix.rows.map((r) => r.name.split(' ')[0] + ':' + r.early)));
  check('the afternoon ones are spread the same way', mix.lateSpread <= 1,
    'afternoon rooms per cleaner: ' + JSON.stringify(mix.rows.map((r) => r.name.split(' ')[0] + ':' + r.late)));
  check('everybody ends up with a mixture, not one kind', mix.everyoneHasBoth,
    'per cleaner: ' + JSON.stringify(mix.rows));
  check('morning sorts above ordinary, ordinary above afternoon', mix.slotOrder, 'slot ordering is wrong');
  await page.evaluate(() => {                                  // clear the preferences again
    (state.servicedUnits || []).forEach((u) => { u.preferEarly = false; u.preferLate = false; });
    save(); render();
  });

  console.log('\n\x1b[1mEVERY OTHER FRIDAY — the rest day is shared, not skipped\x1b[0m');
  const alt = await page.evaluate(() => {
    const crew = cleaningStaff();
    const per = Math.min(3, crew.length);
    const rota = buildDayRota(5, per);
    applyDayRota(5, rota);
    let f1 = todayKey();                            // the next Friday, whenever it falls
    for (let i = 0; i < 8 && new Date(f1 + 'T00:00:00').getDay() !== 5; i += 1) f1 = shiftDay(f1, 1);
    // Walk a whole cycle of Fridays and count how often each person is in.
    const perFriday = [], tally = {};
    crew.forEach((p) => { tally[p.name] = 0; });
    for (let w = 0; w < rota.cycle; w += 1) {
      const d = shiftDay(f1, w * 7);
      const inThatDay = crew.filter((p) => worksOnDay(p, d));
      perFriday.push(inThatDay.length);
      inThatDay.forEach((p) => { tally[p.name] += 1; });
    }
    const counts = Object.values(tally);
    return {
      crew: crew.length, per, cycle: rota.cycle, perFriday, tally,
      sameEveryFriday: perFriday.every((n) => n === perFriday[0]),
      fairness: Math.max(...counts) - Math.min(...counts),
      monday: crew.filter((p) => worksOnDay(p, shiftDay(f1, 3))).length,
    };
  });
  eq('the same number are in every Friday', alt.sameEveryFriday, true);
  eq('and that number is the one asked for', alt.perFriday[0], alt.per);
  check('everybody does the same number of Fridays', alt.fairness === 0,
    'Fridays each: ' + JSON.stringify(alt.tally));
  check('a rota needs more than one week to come round', alt.cycle > 1, 'cycle: ' + alt.cycle);
  eq('a Friday rota leaves the other days alone', alt.monday, alt.crew);
  await page.evaluate(() => {                          // hand every Friday back
    (state.staff || []).forEach((p) => { if (p.alt) delete p.alt; });
    save(); render();
  });

  console.log('\n\x1b[1mPUT THE BOARD BACK — unassign the whole morning at once\x1b[0m');
  await go('rollcall');
  await page.waitForTimeout(1800);
  await autoAssign();                                   // give the board something to clear
  const heldBefore = await page.evaluate(() => (state.servicedUnits || [])
    .filter((u) => onRollCall(u) && onTodaysList(u) && u.assignedTo && !u.usualTo).map((u) => u.unit));
  check('rooms are handed out to begin with', heldBefore.length > 0, 'nothing was assigned');
  const clearBtn = page.locator('button', { hasText: 'back in the pool' }).first();
  check('the roll call offers a clear-the-board button', await clearBtn.count() > 0, 'no unassign-all button');
  contains('it says how many it will clear', await clearBtn.textContent(), String(heldBefore.length));
  await clearBtn.click();
  await page.locator('#confirmModal .modal-btns button').last().click();
  await page.waitForTimeout(1800);
  const heldAfter = await page.evaluate(() => (state.servicedUnits || [])
    .filter((u) => onRollCall(u) && onTodaysList(u) && u.assignedTo && !u.usualTo).map((u) => u.unit));
  eq('every hand-out is back in the pool', heldAfter.length, 0);
  const stillSigned = await page.evaluate(() => Object.keys(state.assignConfirmed || {}).length);
  eq('nothing is left signed off for a room nobody holds', stillSigned, 0);
  // A permanent cleaner is a standing decision, not a morning hand-out.
  const usualKept = await page.evaluate(() => (state.servicedUnits || [])
    .filter((u) => u.usualTo).every((u) => u.assignedTo === u.usualTo));
  check('rooms with a permanent cleaner keep that person', usualKept, 'a permanent assignment was cleared');
  // Undo has to speak about what actually happened, not always "auto-assign".
  const undoLabel = await page.locator('button', { hasText: 'Undo' }).first().textContent();
  contains('undo names the change it will reverse', undoLabel, 'Undo putting them back');
  await page.locator('button', { hasText: 'Undo' }).first().click();
  await page.waitForTimeout(1800);
  const heldRestored = await page.evaluate(() => (state.servicedUnits || [])
    .filter((u) => onRollCall(u) && onTodaysList(u) && u.assignedTo && !u.usualTo).map((u) => u.unit));
  eq('undo puts the whole board back', heldRestored.sort().join(','), heldBefore.sort().join(','));

  console.log('\n\x1b[1mNOT DUE TODAY — off-day rooms stay visible, and stay out of the way\x1b[0m');
  // Earlier sections have flipped frequencies about, so put one room on a genuine
  // off day: every-other-day, cleaned yesterday, so it is next due tomorrow.
  const ndDiag = await page.evaluate(() => {
    // Has to be a room the roll call actually covers — an earlier section switches
    // Airbnb off, and a room that is off the roll call is a different case entirely.
    const u = (state.servicedUnits || []).find((x) => onRollCall(x)) || (state.servicedUnits || [])[0];
    // daysSince() measures from todayKey(), so the off-day date has to be built
    // from todayKey() too — workToday() rolls over at 3am and would be a day out.
    u.freq = 'eod';
    u.lastCleaned = shiftDay(todayKey(), -1);
    u.cycleShiftFrom = null; u.cycleShift = 0;      // no stale spread offset in the way
    delete state.completions['su:' + u.id + '::' + workToday()];
    delete state.logRefs['su:' + u.id + '::' + workToday()];
    save(); render();
    return { unit: u.unit, last: lastCleanDate(u), cycleLen: cycleLen(u),
      due: unitDueToday(u), cleaned: cleanedToday(u), onList: onTodaysList(u), onRoll: onRollCall(u) };
  });
  await page.waitForTimeout(1800);
  const notDue = await page.evaluate(() => (state.servicedUnits || [])
    .filter((u) => onRollCall(u) && !onTodaysList(u) && !u.paused).map((u) => u.unit));
  check('there are off-day rooms to show', notDue.length > 0, 'set-up room: ' + JSON.stringify(ndDiag));
  const rollText = await page.locator('.body').first().innerText();
  contains('the roll call lists them rather than dropping them', rollText, 'Not due today (' + notDue.length + ')');
  contains('and says when each one comes round', rollText, notDue[0] + ' · ');
  // The whole point of keeping them separate: they must not be swept into the count,
  // the hand-out, or the close-out.
  const bleed = await page.evaluate(() => {
    const o = rollCallOutstanding();
    return o.rooms.filter((u) => !onTodaysList(u)).map((u) => u.unit);
  });
  eq('an off-day room is never part of the close-out', bleed.length, 0);
  // Put it back on the board — the close-out sections below need real work to do.
  await page.evaluate((u) => {
    const room = (state.servicedUnits || []).find((x) => x.unit === u);
    if (room) { room.freq = 'daily'; room.lastCleaned = null; }
    save(); render();
  }, ndDiag.unit);
  await page.waitForTimeout(300);

  console.log('\n\x1b[1mCLOSE OUT THE MORNING — one button for the whole roll call\x1b[0m');
  const allBtn = page.locator('button', { hasText: 'Mark all' }).first();
  check('the roll call offers a single mark-all button', await allBtn.count() > 0, 'no mark-all button on Roll Call');
  const allLabel = await allBtn.textContent();
  // The label spells the total out — "14 rooms + 6 areas" — so a number on a button
  // can always be checked against what is on the screen.
  const allTotal = (allLabel.match(/(\d+)\s+(?:room|area)/g) || [])
    .reduce((n, part) => n + Number(part.match(/\d+/)[0]), 0);
  check('it says how many it will close out', allTotal > 0, 'label: ' + JSON.stringify(allLabel));
  // What is still open right now, straight from the app, so the assertion does not
  // depend on how earlier sections left the state.
  const before = await page.evaluate(() => {
    const o = rollCallOutstanding();
    // The close-out covers what somebody was actually given. A room nobody holds is
    // left out on purpose, so it cannot be recorded as cleaned by nobody.
    return { rooms: o.rooms.filter((u) => u.assignedTo).map((u) => u.unit),
             areas: o.areas.map((a) => a.label),
             loose: o.rooms.filter((u) => !u.assignedTo).length };
  });
  eq('the count matches what has actually been handed out', allTotal, before.rooms.length + before.areas.length);
  check('it covers the communal areas too, not just rooms', before.areas.length > 0, 'no areas were outstanding to prove this');

  const loggedBefore = logged.length;
  const postsBefore = logPosts;
  await allBtn.click();
  await page.locator('#confirmModal .modal-btns button').last().click();   // it asks first
  await page.waitForTimeout(1800);

  const after = await page.evaluate(() => {
    const o = rollCallOutstanding();
    return { rooms: o.rooms.map((u) => u.unit), areas: o.areas.map((a) => a.label) };
  });
  eq('every room on the roll call is now cleaned', after.rooms.length, 0);
  eq('every communal area is now done', after.areas.length, 0);
  eq('the whole lot went in one write, not one per room', logPosts - postsBefore, 1);
  eq('one history row per job', logged.length - loggedBefore, before.rooms.length + before.areas.length);
  const wrote = logged.slice(loggedBefore);
  check('each row names the job it was for', wrote.every((r) => r.unit_label), 'rows: ' + JSON.stringify(wrote.map((r) => r.unit_label)));
  check('each row is credited to somebody', wrote.every((r) => r.cleaner_id && r.cleaner_name), 'rows: ' + JSON.stringify(wrote.map((r) => r.cleaner_name)));
  check('the areas are in there under their own names', before.areas.every((l) => wrote.some((r) => r.unit_label === l)),
    'wrote: ' + JSON.stringify(wrote.map((r) => r.unit_label)));
  // Airbnb is a separate job on its own tab and is deliberately off the roll call —
  // a bulk close-out of the morning must never tick it off as well.
  const airbnbSwept = await page.evaluate(() => (state.servicedUnits || [])
    .filter((u) => !onRollCall(u) && servicedDone(u.id)).map((u) => u.unit));
  eq('nothing off the roll call was swept in with it', airbnbSwept.length, 0);

  // The point of keeping a history id per tick: the bulk close-out must not weld
  // the morning shut. Any single job can still be put back on its own.
  const oneRoom = before.rooms[0];
  const undone = await page.evaluate((unit) => {
    const u = (state.servicedUnits || []).find((x) => x.unit === unit);
    if (!u) return null;
    const hadRef = !!state.logRefs['su:' + u.id + '::' + workToday()];
    toggleServicedDone(u.id);
    return { hadRef, nowDone: servicedDone(u.id) };
  }, oneRoom);
  check('a bulk-ticked room keeps its own history reference', undone && undone.hadRef, 'no logRef stored for ' + oneRoom);
  check('and can still be un-ticked on its own afterwards', undone && undone.nowDone === false, 'could not un-tick ' + oneRoom);

  console.log('\n\x1b[1mCLOSE OUT THE ROUND — one button for the whole night\x1b[0m');
  // By this point the earlier sections have ticked nearly everything off, so put the
  // board back to a full night's work and match the live config: Airbnb is switched
  // off the roll call, being a separate job done by its own pair on its own tab.
  // Without both, "roll call skips Airbnb" and "tonight picks it up" prove nothing.
  await page.evaluate(() => {
    if (!Array.isArray(state.rollCallTypes) || state.rollCallTypes.includes('airbnb')) toggleRollCallType('airbnb');
    (state.servicedUnits || []).forEach((u) => {
      delete state.completions['su:' + u.id + '::' + workToday()];
      u.lastCleaned = null;                 // never recorded → due, whatever its frequency
    });
    save(); render();
  });
  await go('tonight');
  await page.waitForTimeout(1800);
  const offRollCall = await page.evaluate(() => tonightOutstanding().rooms
    .filter((u) => !onRollCall(u)).map((u) => u.unit));
  check('tonight still lists the jobs roll call leaves out', offRollCall.length > 0,
    'nothing off-roll-call was outstanding, so this proves nothing');
  const nightBtn = page.locator('button', { hasText: 'Mark all' }).first();
  check("tonight's round offers the same one-button close-out", await nightBtn.count() > 0, 'no mark-all button on Tonight');
  const nightLabel = await nightBtn.textContent();
  const nightTotal = Number((nightLabel.match(/Mark all (\d+)/) || [])[1] || 0);
  const nightBefore = await page.evaluate(() => {
    const o = tonightOutstanding();
    return { rooms: o.rooms.map((u) => u.unit), areas: o.areas.map((a) => a.label), cards: o.jobs.length };
  });
  eq('the button counts the same jobs the list shows', nightTotal, nightBefore.cards);

  const nightLogged = logged.length, nightPosts = logPosts;
  await nightBtn.click();
  await page.locator('#confirmModal .modal-btns button').last().click();
  await page.waitForTimeout(1800);

  const nightAfter = await page.evaluate(() => tonightOutstanding().jobs.length);
  eq('the whole round is closed out', nightAfter, 0);
  eq('it too went in a single write', logPosts - nightPosts, 1);
  eq('one history row per job on the round', logged.length - nightLogged, nightBefore.rooms.length + nightBefore.areas.length);
  const nightRows = logged.slice(nightLogged).map((r) => r.unit_label);
  check('the off-roll-call jobs are in there', offRollCall.every((u) => nightRows.includes(u)),
    'expected ' + JSON.stringify(offRollCall) + ' in ' + JSON.stringify(nightRows));

  // ------------------------------------------------- LAST NIGHT'S PLAN TODAY
  // Planning tomorrow and then watching the morning deal it all out again from
  // scratch made the planning pointless. The roll call now honours it.
  console.log('\n\x1b[1mLAST NIGHT’S PLAN — carried into the morning\x1b[0m');
  const carry = await page.evaluate(() => {
    // One cleaner stays home this morning, whoever badged in earlier in the run.
    // Earlier sections switch room kinds off the roll call; put them all back so
    // there is a full morning to deal with.
    state.rollCallTypes = null;
    const cleaners = (state.staff || []).filter((p) => p.isCleaner).map((p) => p.id);
    const stayHome = cleaners[cleaners.length - 1];
    delete hikArrivals[stayHome];
    const inIds = Object.keys(hikArrivals).filter((id) => (state.staff || []).some((s) => s.id === id));
    const absent = cleaners.filter((id) => !inIds.includes(id));
    // Put the morning back to un-cleaned so there is work to hand out at all. The
    // room's own stamp AND the shared history both have to go, or the log still
    // reads as cleaned today and nothing is due.
    const rooms = state.servicedUnits.filter((u) => onRollCall(u)).slice(0, 4);
    rooms.forEach((u) => {
      delete state.completions['su:' + u.id + '::' + workToday()];
      // Earlier sections stagger the schedule, which holds rooms back off today.
      u.lastCleaned = null; u.assignedTo = null; u.usualTo = null;
      delete u.holdUntil; delete u.alsoCleanOn;
      delete lastCleanedByUnit[u.id];
      delete state.assignConfirmed[u.id];
    });
    const due = state.servicedUnits.filter((u) => onRollCall(u) && unitDueToday(u));
    due.forEach((u) => { u.assignedTo = null; delete state.assignConfirmed[u.id]; });
    if (due.length < 2 || !absent.length) return { tooFew: true, due: due.length, absentId: absent[0], inIds };

    // Last night somebody planned these two: one for a person who turned up, one
    // for a person who did not.
    const day = todayKey();
    state.plans[day] = {};
    const a = due[0], b = due[1];
    state.plans[day][planKey('unit', a.id)] = { kind: 'unit', refId: a.id, label: 'a', assignedTo: inIds[0], auto: true };
    state.plans[day][planKey('unit', b.id)] = { kind: 'unit', refId: b.id, label: 'b', assignedTo: absent[0], auto: true };

    delete state.autoAssignedOn;
    maybeAutoAssign();
    const now = (id) => state.servicedUnits.find((u) => u.id === id);
    return {
      inIds, absentId: absent[0], plannedFor: inIds[0],
      a: { id: a.id, got: (now(a.id) || {}).assignedTo, confirmed: state.assignConfirmed[a.id] === day },
      b: { id: b.id, got: (now(b.id) || {}).assignedTo },
      due: due.length,
      unassigned: state.servicedUnits.filter((u) => onRollCall(u) && unitDueToday(u) && !u.assignedTo).length,
    };
  });
  check('there is a morning to hand out and somebody who stayed home', !carry.tooFew,
    'fixture gave ' + carry.due + ' due rooms, absent=' + carry.absentId);
  if (!carry.tooFew) {
    eq('a room planned for somebody who turned up stays with them', carry.a.got, carry.plannedFor);
    check('and it counts as settled rather than a fresh suggestion', carry.a.confirmed, 'not marked as checked');
    check('a room planned for somebody who never came in goes to somebody who did',
      !!carry.b.got && carry.b.got !== carry.absentId && carry.inIds.includes(carry.b.got),
      'room went to ' + carry.b.got + ' (planned for the absent ' + carry.absentId + ')');
    eq('nothing due is left without a cleaner', carry.unassigned, 0);
  }

  // --------------------------------------------------------- TOMORROW, AUTO
  // Tomorrow used to exist only once somebody opened the Plan tab for it.
  console.log('\n\x1b[1mTOMORROW — laid out without being asked\x1b[0m');

  const planState = () => page.evaluate(() => {
    const d = tomorrowKey();
    const plan = state.plans[d] || {};
    const rooms = Object.entries(plan).filter(([, v]) => v.kind === 'unit');
    return {
      day: d,
      jobs: Object.keys(plan).length,
      rooms: rooms.map(([k]) => k),
      assigned: rooms.filter(([, v]) => v.assignedTo).length,
      assignees: [...new Set(rooms.map(([, v]) => v.assignedTo).filter(Boolean))],
      rostered: cleaningStaff().filter((p) => worksOnDay(p, d)).map((p) => p.id),
    };
  });

  // Start from nothing planned, then do what opening the app does — not what
  // opening the Plan tab does.
  await page.evaluate(() => {
    const d = tomorrowKey();
    delete state.plans[d];
    delete state.planSeeded[d];
    if (state.planDropped) delete state.planDropped[d];
    ensureTomorrowPlanned();
  });
  const t1 = await planState();
  check('opening the app lays tomorrow out, without visiting the Plan tab', t1.jobs > 0, 'tomorrow is still empty');
  check('and it puts rooms on it, not just areas', t1.rooms.length > 0, 'no rooms planned');
  check('the rooms are handed round', t1.assigned > 0, 'nobody was given anything');
  check('and only to people rostered on that day',
    t1.assignees.every((id) => t1.rostered.includes(id)),
    'assigned to ' + JSON.stringify(t1.assignees) + ' but rostered: ' + JSON.stringify(t1.rostered));

  // Re-running must be idempotent — an app reopened twice must not double up
  // or re-deal work somebody has already been given.
  const beforeAgain = await page.evaluate(() => JSON.stringify(state.plans[tomorrowKey()]));
  await page.evaluate(() => ensureTomorrowPlanned());
  eq('reopening the app changes nothing that is already planned',
    await page.evaluate(() => JSON.stringify(state.plans[tomorrowKey()])), beforeAgain);

  // Rooms the customer asked for first thing must be shared out, not stacked on
  // whoever happens to be lightest overall. The re-sync used to weigh total load
  // only, so one person could end up holding the entire early round.
  const early = await page.evaluate(() => {
    const d = tomorrowKey();
    // Three rooms wanted early tomorrow, whatever their cycle says.
    const picked = state.servicedUnits.filter((u) => onRollCall(u)).slice(0, 3);
    picked.forEach((u) => { u.preferEarly = true; u.alsoCleanOn = d; u.lastCleanedBy = null; });
    // Take them off the plan so the re-sync is what puts them back.
    picked.forEach((u) => { delete state.plans[d][planKey('unit', u.id)]; });
    if (state.planDropped) delete state.planDropped[d];
    resyncPlanDay(d);
    const plan = state.plans[d];
    const holders = picked.map((u) => (plan[planKey('unit', u.id)] || {}).assignedTo);
    return {
      picked: picked.length,
      holders,
      placed: holders.filter(Boolean).length,
      distinct: [...new Set(holders.filter(Boolean))].length,
      rostered: cleaningStaff().filter((p) => worksOnDay(p, d)).length,
    };
  });
  eq('all three early rooms are put on tomorrow', early.placed, early.picked);
  check('and they are shared out rather than stacked on one person',
    early.distinct >= Math.min(early.picked, early.rostered),
    early.picked + ' early rooms went to ' + early.distinct + ' of ' + early.rostered + ' rostered cleaners: '
      + JSON.stringify(early.holders));

  // A re-sync must not disturb work already handed to somebody. Checked before the
  // removal test below, which takes that same room off the plan.
  const held = await page.evaluate(() => {
    const plan = state.plans[tomorrowKey()];
    const k = Object.keys(plan).find((x) => plan[x].kind === 'unit' && plan[x].assignedTo);
    return k ? { k, who: plan[k].assignedTo } : null;
  });
  check('somebody is holding a room for tomorrow', !!held, 'nothing was assigned to test against');
  if (held) {
    await page.evaluate(() => resyncPlanDay(tomorrowKey()));
    eq('a re-sync leaves an existing hand-out alone',
      await page.evaluate((k) => (state.plans[tomorrowKey()][k] || {}).assignedTo, held.k), held.who);
  }

  // A job taken off by hand must stay off. This is what makes the re-sync safe:
  // without it the schedule silently puts the room back and the tap looks broken.
  const dropKey = t1.rooms[0];
  await page.evaluate((k) => {
    const [kind, id] = [k.split(':')[0], k.split(':').slice(1).join(':')];
    togglePlanJob(tomorrowKey(), kind, id, 'x');
  }, dropKey);
  check('a job can be taken off tomorrow', !(await planState()).rooms.includes(dropKey), 'it is still on the plan');
  check('the schedule still says that room is due', await page.evaluate((k) =>
    planningJobsFor(tomorrowKey()).some((j) => j.kind + ':' + j.id === k), dropKey),
    'the room stopped being due, so the re-sync below proves nothing');
  await page.evaluate(() => resyncPlanDay(tomorrowKey()));
  check('and the schedule does not put it back',
    !(await planState()).rooms.includes(dropKey), 'the re-sync re-added a job that was removed by hand');

  // ------------------------------------------- TOMORROW ON THE ROLL CALL
  // The roll call is the screen the office lives on. "Is tomorrow sorted?" meant
  // going to another tab to find out.
  console.log('\n\x1b[1mROLL CALL — tomorrow is on it\x1b[0m');
  await page.evaluate(() => {
    const d = tomorrowKey();
    delete state.plans[d]; delete state.planSeeded[d];
    if (state.planDropped) delete state.planDropped[d];
    planDay = null; state.tab = 'rollcall'; render();
  });
  await page.waitForTimeout(1800);
  const rcEmpty = await page.locator('.section-label', { hasText: 'Tomorrow (' }).count();
  check('the roll call has a Tomorrow panel', rcEmpty > 0, 'no Tomorrow section on the roll call');
  check('it says when nothing is laid out yet',
    (await page.locator('text=Nothing laid out yet').count()) > 0, 'no empty-state line');

  // Today and tomorrow are built by different routes — today from the rooms' real
  // last-clean dates, tomorrow from the projection — so the panel puts them side by
  // side, and flags a room sitting on both days for no good reason.
  const cmp = await page.evaluate(() => {
    state.rollCallTypes = null;
    const rooms = state.servicedUnits.filter((u) => onRollCall(u)).slice(0, 3);
    const d = tomorrowKey();
    state.plans[d] = {}; state.planSeeded[d] = true;
    rooms.forEach((u, i) => {
      delete lastCleanedByUnit[u.id];
      delete u.holdUntil; delete u.alsoCleanOn;
      u.lastCleaned = null;                    // never cleaned → due today
      u.freq = i === 0 ? 'daily' : 'eod';
      state.plans[d][planKey('unit', u.id)] = { kind: 'unit', refId: u.id, label: 'Unit ' + u.unit, auto: true };
    });
    // rooms[1] is every-other-day and on both days with nothing to justify it.
    rooms[2].alsoCleanOn = d;                  // this one was split on purpose
    state.tab = 'rollcall'; render();
    return { flagged: rooms[1].unit, daily: rooms[0].unit, split: rooms[2].unit };
  });
  await page.waitForTimeout(1800);
  const cmpText = await page.locator('.section-label', { hasText: 'Tomorrow (' }).first()
    .evaluate((e) => e.parentElement.textContent);
  contains('the panel puts today and tomorrow side by side', cmpText, 'Today ');
  contains('and counts what is on both days', cmpText, 'on both days');
  contains('an every-other-day room on both days is flagged', cmpText, cmp.flagged);
  // Only the rooms named in the warning sentence itself count as flagged — the
  // cleaner chips below it list every room and would match anything.
  const warned = (cmpText.match(/⚠ ([^⚠]*?) (?:is|are) on both days/) || [])[1] || '';
  check('a daily room on both days is not flagged', !warned.includes(cmp.daily),
    'the daily room ' + cmp.daily + ' was flagged: "' + warned + '"');
  check('nor is one the leveller split on purpose', !warned.includes(cmp.split),
    'the deliberately split room ' + cmp.split + ' was flagged: "' + warned + '"');

  const rcBtn = page.locator('button', { hasText: "Plan tomorrow's rooms" }).first();
  check('and offers the one button right there', await rcBtn.count() > 0, 'no plan button on the roll call');
  await rcBtn.click();
  await page.waitForTimeout(1800);
  const afterRc = await page.evaluate(() => {
    const d = tomorrowKey();
    const rooms = Object.values(state.plans[d] || {}).filter((v) => v.kind === 'unit');
    return { tab: state.tab, planDay, rooms: rooms.length, assigned: rooms.filter((v) => v.assignedTo).length };
  });
  check('pressing it plans tomorrow', afterRc.rooms > 0, 'tomorrow is still empty');
  eq('and takes you to it to edit', afterRc.tab, 'plan');

  // Back on the roll call it must now report the hand-out rather than the empty state.
  await page.evaluate(() => { state.tab = 'rollcall'; render(); });
  await page.waitForTimeout(1800);
  const rcLabel = await page.locator('.section-label', { hasText: 'Tomorrow (' }).first().textContent();
  contains('the panel counts the rooms it planned', rcLabel, String(afterRc.rooms));
  check('and no longer says nothing is laid out',
    (await page.locator('text=Nothing laid out yet').count()) === 0, 'still showing the empty state');

  // ------------------------------------------------- LEVELS WITHOUT ASKING
  // Waiting to be asked meant the every-other-day rooms went on stacking until
  // somebody noticed the chart and went looking for the button.
  console.log('\n\x1b[1mLEVELS ITSELF — nobody has to notice\x1b[0m');
  const autoLvl = await page.evaluate(() => {
    state.rollCallTypes = null;
    const saved = JSON.parse(JSON.stringify(state.servicedUnits));
    state.servicedUnits = [];
    for (let i = 1; i <= 20; i += 1) state.servicedUnits.push({
      id: 'a' + i, unit: String(400 + i), freq: 'eod', lastCleaned: shiftDay(workToday(), -1),
    });
    delete state.autoLevelledOn; delete state.lastAutoLevel;
    state.autoBalance = true;

    const before = levelPlan(14).settledBefore;
    const ran = autoLevelIfLopsided();                 // what opening the app does
    const settled = Object.values(projectedCounts(14)).slice(7);
    // Pressing on shouldn't keep churning the schedule all day.
    const again = autoLevelIfLopsided();

    // And it must stay off when the office has turned it off.
    state.autoBalance = false;
    delete state.autoLevelledOn;
    state.servicedUnits.forEach((u) => { delete u.alsoCleanOn; u.lastCleaned = shiftDay(workToday(), -1); });
    const offRun = autoLevelIfLopsided();

    const out = { before, moves: ran.moves, again: again.moves, offRun: offRun.moves,
                  peak: Math.max(...settled), note: state.lastAutoLevel };
    state.servicedUnits = saved;
    state.autoBalance = true;
    return out;
  });
  check('opening the app levels a lopsided fortnight on its own', autoLvl.moves > 0,
    'it proposed nothing, from a settled peak of ' + autoLvl.before);
  check('the days really do come out level', autoLvl.peak <= autoLvl.before / 2 + 1,
    'settled peak ' + autoLvl.before + ' → ' + autoLvl.peak);
  eq('it does not keep churning the schedule all day', autoLvl.again, 0);
  eq('and it stays out of it when the setting is off', autoLvl.offRun, 0);
  check('it records what it did, so the change is not invisible',
    !!autoLvl.note && autoLvl.note.moves > 0, 'nothing recorded: ' + JSON.stringify(autoLvl.note));

  // ------------------------------------------- LAST NIGHT'S PLAN, NEXT MORNING
  // The morning the planned day arrives, the plan has to be ON the board — not one
  // tab away waiting for somebody to press something.
  console.log('\n\x1b[1mTHE PLANNED DAY ARRIVES — it is already on the board\x1b[0m');
  const arrives = await page.evaluate(() => {
    state.rollCallTypes = null;
    const d = todayKey();
    const crew = cleaningStaff();
    const rooms = state.servicedUnits.filter((u) => onRollCall(u)).slice(0, 3);
    // Last night somebody planned today. Nothing is on the board yet.
    state.plans[d] = {};
    rooms.forEach((u, i) => {
      u.assignedTo = null; delete state.assignConfirmed[u.id];
      state.plans[d][planKey('unit', u.id)] =
        { kind: 'unit', refId: u.id, label: 'Unit ' + u.unit, assignedTo: crew[i % crew.length].id, auto: true };
    });
    // One of them the office has already given to somebody else this morning.
    const touched = rooms[0];
    const other = crew[crew.length - 1];
    touched.assignedTo = other.id;

    const moved = carryPlanToBoardOnOpen();
    return {
      moved,
      onBoard: rooms.filter((u) => u.assignedTo).length,
      total: rooms.length,
      matchesPlan: rooms.slice(1).every((u) =>
        u.assignedTo === state.plans[d][planKey('unit', u.id)].assignedTo),
      signedOff: rooms.slice(1).every((u) => state.assignConfirmed[u.id] === d),
      touchedKept: touched.assignedTo === other.id,
    };
  });
  eq('opening the app puts the whole plan on the board', arrives.onBoard, arrives.total);
  check('with each room going to the person it was planned for', arrives.matchesPlan, 'the board does not match the plan');
  check('and counting as signed off, not as a fresh suggestion', arrives.signedOff, 'not marked as checked');
  check('but a room already changed on the board that morning is left alone',
    arrives.touchedKept, 'the plan overwrote a hand-out made on the board');

  // ------------------------------------------ THE PLAN *IS* TODAY'S ROLL CALL
  // The roll call used to work its own rooms out from each room's dates while the
  // plan lived elsewhere — two answers to the same question, so a day planned last
  // night turned up on the board with different rooms on it.
  console.log('\n\x1b[1mONE LIST — the plan is what the roll call shows\x1b[0m');
  const oneList = await page.evaluate(() => {
    state.rollCallTypes = null;
    const d = todayKey();
    const all = state.servicedUnits.filter((u) => onRollCall(u));
    // Make everything due today, then plan only two of them.
    all.forEach((u) => { u.lastCleaned = null; delete lastCleanedByUnit[u.id]; delete u.holdUntil; });
    const derived = all.filter((u) => onTodaysList(u)).length;
    const picked = all.slice(0, 2);
    state.plans[d] = {};
    picked.forEach((u) => {
      state.plans[d][planKey('unit', u.id)] = { kind: 'unit', refId: u.id, label: 'Unit ' + u.unit, auto: true };
    });
    const listed = todaysRoomList().map((u) => u.id);
    const outstanding = rollCallOutstanding().rooms.map((u) => u.id);
    // With the plan cleared away, the schedule decides again as it always did.
    delete state.plans[d];
    return { derived, planned: picked.map((u) => u.id), listed, outstanding,
             fallback: todaysRoomList().length };
  });
  check('the schedule alone would put more rooms on today', oneList.derived > oneList.planned.length,
    oneList.derived + ' due vs ' + oneList.planned.length + ' planned — nothing to tell apart');
  eq('the roll call shows exactly what was planned, no more', oneList.listed.length, oneList.planned.length);
  check('and they are the planned rooms', oneList.planned.every((id) => oneList.listed.includes(id)),
    JSON.stringify(oneList.listed) + ' vs planned ' + JSON.stringify(oneList.planned));
  check('the close-out covers the same rooms and no others',
    oneList.outstanding.length === oneList.planned.length
      && oneList.planned.every((id) => oneList.outstanding.includes(id)),
    JSON.stringify(oneList.outstanding));
  eq('with no plan, the schedule decides as before', oneList.fallback, oneList.derived);

  // Work nobody got to does not stop needing doing. A day ahead is planned from a
  // projection that assumes each day gets done, so yesterday's misses are not in
  // today's plan — and now that the plan IS the board, they would vanish.
  const missed = await page.evaluate(() => {
    state.rollCallTypes = null;
    const d = todayKey(), y = shiftDay(d, -1);
    const all = state.servicedUnits.filter((u) => onRollCall(u));
    const skipped = all[0], donePast = all[1], planned = all[2];
    all.forEach((u) => { delete u.holdUntil; delete lastCleanedByUnit[u.id]; });
    skipped.lastCleaned = shiftDay(d, -9);        // planned yesterday, never done
    donePast.lastCleaned = y;                     // planned yesterday and done
    state.plans[y] = {
      [planKey('unit', skipped.id)]: { kind: 'unit', refId: skipped.id, label: 'Unit ' + skipped.unit },
      [planKey('unit', donePast.id)]: { kind: 'unit', refId: donePast.id, label: 'Unit ' + donePast.unit },
    };
    state.plans[d] = {
      [planKey('unit', planned.id)]: { kind: 'unit', refId: planned.id, label: 'Unit ' + planned.unit },
    };
    const ids = todaysRoomList().map((u) => u.id);
    delete state.plans[y]; delete state.plans[d];
    return { ids, skipped: skipped.id, donePast: donePast.id, planned: planned.id };
  });
  check("today still shows what today's plan asked for", missed.ids.includes(missed.planned),
    JSON.stringify(missed.ids));
  check('a room planned yesterday and never done is carried onto today',
    missed.ids.includes(missed.skipped), 'the missed room vanished: ' + JSON.stringify(missed.ids));
  check('one that did get done yesterday is not dragged back',
    !missed.ids.includes(missed.donePast), 'a finished room came back: ' + JSON.stringify(missed.ids));

  // -------------------------------------------------------- SOMEBODY IS OFF
  // The plan is only worth having if it survives somebody phoning in sick.
  console.log('\n\x1b[1mSOMEBODY IS OFF — the day is dealt round the rest\x1b[0m');
  const sick = await page.evaluate(() => {
    const d = tomorrowKey();
    const plan = state.plans[d] || {};
    const rooms = Object.values(plan).filter((v) => v.kind === 'unit');
    // Give one person the lot, then take them out.
    const crew = cleaningStaff().filter((p) => worksOnDay(p, d));
    const victim = crew[0];
    Object.keys(plan).forEach((k) => { if (plan[k].kind === 'unit') plan[k].assignedTo = victim.id; });
    const had = rooms.length;
    const r = sharePersonsRoomsOut(d, victim.id);
    const after = Object.values(state.plans[d]).filter((v) => v.kind === 'unit');
    return {
      had, moved: r.moved, victim: victim.id, crew: crew.length,
      stillTheirs: after.filter((v) => v.assignedTo === victim.id).length,
      spread: [...new Set(after.map((v) => v.assignedTo).filter(Boolean))].length,
      unhanded: after.filter((v) => !v.assignedTo).length,
    };
  });
  check('there was a full day on one person to move', sick.had > 1, 'only ' + sick.had + ' rooms');
  eq('none of it is left with the person who is off', sick.stillTheirs, 0);
  check('it is dealt round the others', sick.spread >= Math.min(sick.crew - 1, 2),
    'went to only ' + sick.spread + ' of ' + (sick.crew - 1) + ' remaining');
  eq('and nothing is dropped on the floor', sick.unhanded, 0);

  // Marking somebody sick must keep today's hand-out away from them.
  const sickStatus = await page.evaluate(() => {
    const p = cleaningStaff()[0];
    state.attendance[p.id] = 'sick';
    const d = todayKey();
    state.plans[d] = state.plans[d] || {};
    const dealt = autoPlanDay(d);
    const got = Object.values(state.plans[d]).filter((v) => v.kind === 'unit' && v.assignedTo === p.id).length;
    state.attendance[p.id] = 'present';
    return { id: p.id, got, order: STATUS_ORDER, dealt: dealt.assigned };
  });
  check('sick is one of the statuses a person can be put in', sickStatus.order.includes('sick'),
    'statuses are ' + JSON.stringify(sickStatus.order));
  eq('somebody marked sick is given no rooms today', sickStatus.got, 0);

  // ------------------------------------------------- PLAN A DAY, AS A ROTA
  // The day's list is sent to the crew as a screenshot, so it has to fit on a screen
  // and read as a rota. It used to be two rows and a full-width dropdown per room.
  console.log('\n\x1b[1mPLAN A DAY — the day fits on a screen\x1b[0m');
  await page.evaluate(() => { planDay = tomorrowKey(); planMore = false; state.tab = 'plan'; render(); });
  await page.waitForTimeout(1800);
  const shape = await page.evaluate(() => {
    const d = tomorrowKey();
    const rooms = Object.values(state.plans[d] || {}).filter((v) => v.kind === 'unit');
    const who = [...new Set(rooms.map((v) => v.assignedTo).filter(Boolean))]
      .map((id) => (state.staff.find((p) => p.id === id) || {}).name);
    // .section-label is uppercased by CSS, so innerText comes back shouting.
    return { rooms: rooms.length, who, body: document.body.innerText.toLowerCase(),
             selects: document.querySelectorAll('select').length };
  });
  check('the day is grouped under each cleaner by name',
    shape.who.every((n) => shape.body.includes(String(n).toLowerCase())),
    'missing from the page: ' + JSON.stringify(shape.who));
  check('with no dropdown per room left to make it long — at most one per person',
    shape.selects <= shape.who.length + 1, shape.selects + ' selects for ' + shape.who.length + ' cleaners');
  check('the week chart is folded away by default',
    !shape.body.includes('the week ahead'), 'the week chart is still on the screen');
  check('and the pool of jobs to add is too',
    !shape.body.includes('add jobs to this day'), 'the add-jobs pool is still on the screen');

  // Editing is the roll call's: tap a chip to take the room off somebody, and use
  // the per-person dropdown to give them one.
  const roomChip = page.locator('.freqmini', { hasText: /\d+ ✕$/ }).first();
  check('rooms are chips with an ✕, as on the roll call', await roomChip.count() > 0, 'no room chips found');
  const chipInfo = await page.evaluate(() => {
    const d = tomorrowKey(); const plan = state.plans[d];
    const k = Object.keys(plan).find((x) => plan[x].kind === 'unit' && plan[x].assignedTo);
    return { k, who: plan[k].assignedTo, label: String(plan[k].label).replace(/^Unit\s+/, '') };
  });
  await page.locator('.freqmini', { hasText: new RegExp('(^|\\s)' + chipInfo.label + ' ✕$') }).first().click();
  await page.waitForTimeout(350);
  eq('tapping one takes the room off them',
    await page.evaluate((k) => state.plans[tomorrowKey()][k].assignedTo || '', chipInfo.k), '');
  check('and it turns up under "not handed out"',
    (await page.evaluate(() => document.body.innerText.toLowerCase())).includes('still to hand out'),
    'no unhanded group appeared');

  const giveBack = page.locator(`[data-plan-target="${chipInfo.who}"] select`).first();
  check('each person has an assign dropdown', await giveBack.count() > 0, 'no per-person select');
  await giveBack.selectOption(chipInfo.k);
  await page.waitForTimeout(350);
  eq('and it gives the room back to them',
    await page.evaluate((k) => state.plans[tomorrowKey()][k].assignedTo, chipInfo.k), chipInfo.who);

  // HOLD TO MOVE. Dragging a room onto somebody meant aiming with a thumb at a
  // target underneath your own hand, on a list that scrolls. Same gesture, but it
  // opens a list of names.
  const moveSetup = await page.evaluate(() => {
    const d = tomorrowKey();
    const plan = state.plans[d];
    const k = Object.keys(plan).find((x) => plan[x].kind === 'unit' && plan[x].assignedTo);
    const from = plan[k].assignedTo;
    const to = cleaningStaff().find((p) => p.id !== from && worksOnDay(p, d));
    return k && to ? { k, from, to: to.id, toName: to.name,
                       label: String(plan[k].label).replace(/^Unit\s+/, '') } : null;
  });
  check('there are two cleaners to move a room between', !!moveSetup, 'not enough crew on that day');
  if (moveSetup) {
    const chip = page.locator('.freqmini', { hasText: new RegExp('(^|\\s)' + moveSetup.label + ' ✕$') }).first();
    const bb = await chip.boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1800);                     // hold past the threshold
    await page.mouse.up();
    await page.waitForTimeout(300);
    check('holding a room asks who should have it', (await page.locator('.modal-title').count()) > 0,
      'no move sheet opened');
    contains('and the sheet names the room', await page.locator('.modal-title').textContent(), moveSetup.label);
    await page.locator('.cover-pick', { hasText: moveSetup.toName }).first().click();
    await page.waitForTimeout(300);
    eq('picking somebody moves the room to them',
      await page.evaluate((k) => state.plans[tomorrowKey()][k].assignedTo, moveSetup.k), moveSetup.to);
    eq('and the sheet closes', await page.locator('.modal-title').count(), 0);
  }

  // Show more brings the rest back without it living on the main screen.
  await page.locator('button', { hasText: 'Show more' }).first().click();
  await page.waitForTimeout(1800);
  const expanded = await page.evaluate(() => document.body.innerText.toLowerCase());
  contains('Show more reveals the week chart', expanded, 'the week ahead');
  contains('and the jobs you can add', expanded, 'add jobs to this day');
  await page.evaluate(() => { planMore = false; render(); });

  // ------------------------------------------------ ONE BUTTON FOR TOMORROW
  // The thing the Plan tab is opened to do: plan tomorrow, then edit it.
  console.log('\n\x1b[1mPLAN TOMORROW — one press, then edit\x1b[0m');
  await page.evaluate(() => {
    const d = tomorrowKey();
    delete state.plans[d]; delete state.planSeeded[d];
    if (state.planDropped) delete state.planDropped[d];
    planDay = null; state.tab = 'plan'; render();
  });
  await page.waitForTimeout(1800);
  const tomBtn = page.locator('button', { hasText: "Plan tomorrow's rooms" }).first();
  check('the Plan tab leads with one button for tomorrow', await tomBtn.count() > 0,
    'no "Plan tomorrow" button on the tab');
  await tomBtn.click();
  await page.waitForTimeout(1800);
  const tom = await page.evaluate(() => {
    const d = tomorrowKey();
    const plan = state.plans[d] || {};
    const rooms = Object.values(plan).filter((v) => v.kind === 'unit');
    return { landed: planDay === d, jobs: Object.keys(plan).length, rooms: rooms.length,
             assigned: rooms.filter((v) => v.assignedTo).length,
             rostered: cleaningStaff().filter((p) => worksOnDay(p, d)).length };
  });
  check('one press lays tomorrow out', tom.jobs > 0, 'tomorrow is still empty');
  check('and hands the rooms out', !tom.rooms || !tom.rostered || tom.assigned > 0,
    tom.assigned + ' of ' + tom.rooms + ' handed out');
  check('and leaves you on tomorrow, ready to change it', tom.landed, 'the tab did not move to tomorrow');

  // Editing after pressing it must stick — and pressing again must not undo the edit.
  const edited = await page.evaluate(() => {
    const d = tomorrowKey();
    const plan = state.plans[d];
    const k = Object.keys(plan).find((x) => plan[x].kind === 'unit');
    if (!k) return null;
    setPlanAssignee(d, k, null);
    const dropped = Object.keys(plan).find((x) => plan[x].kind === 'unit' && x !== k);
    if (dropped) togglePlanJob(d, 'unit', plan[dropped].refId, 'x');
    planTomorrow();
    return { k, stillGone: !state.plans[d][dropped], reassigned: !!state.plans[d][k].assignedTo };
  });
  if (edited) {
    check('a job removed after planning stays removed when it is pressed again', edited.stillGone,
      'the removed job came back');
    check('and a room left unassigned gets picked up on the next press', edited.reassigned,
      'it was not handed to anybody');
  }

  // --------------------------------------------- AUTO-ASSIGN ON PLAN A DAY
  // The Plan tab's auto-assign handed rooms to whoever had clocked in, which on a
  // day that has not happened is nobody — so it just failed.
  console.log('\n\x1b[1mPLAN A DAY — auto-assign fits the day it is on\x1b[0m');
  await page.evaluate(() => { planDay = tomorrowKey(); state.tab = 'plan'; render(); });
  await page.waitForTimeout(1800);
  const planBtn = page.locator('button', { hasText: 'Auto-assign' }).first();
  check('the Plan tab offers an auto-assign', await planBtn.count() > 0, 'no auto-assign button on Plan a Day');
  contains('and on a future day it goes by the rota, not the door reader',
    await planBtn.textContent(), 'rostered on');

  const dealt = await page.evaluate(() => {
    const d = tomorrowKey();
    const plan = state.plans[d] || {};
    Object.keys(plan).forEach((k) => { plan[k].assignedTo = null; });
    return { before: Object.values(plan).filter((v) => v.kind === 'unit' && v.assignedTo).length };
  });
  await planBtn.click();
  await page.waitForTimeout(1800);
  const afterDeal = await page.evaluate(() => {
    const plan = state.plans[tomorrowKey()] || {};
    const rooms = Object.values(plan).filter((v) => v.kind === 'unit');
    return { assigned: rooms.filter((v) => v.assignedTo).length, rooms: rooms.length,
             rostered: cleaningStaff().filter((p) => worksOnDay(p, tomorrowKey())).map((p) => p.id),
             who: [...new Set(rooms.map((v) => v.assignedTo).filter(Boolean))] };
  });
  eq('nothing was handed out to begin with', dealt.before, 0);
  check('pressing it hands the rooms out', afterDeal.assigned > 0,
    'still ' + afterDeal.assigned + ' of ' + afterDeal.rooms + ' handed out');
  check('to people rostered on that day', afterDeal.who.every((id) => afterDeal.rostered.includes(id)),
    JSON.stringify(afterDeal.who) + ' vs rostered ' + JSON.stringify(afterDeal.rostered));

  // Today still reads the door, since that is who is actually in.
  await page.evaluate(() => { planDay = todayKey(); render(); });
  await page.waitForTimeout(300);
  const todayBtn = page.locator('button', { hasText: 'Auto-assign' }).first();
  if (await todayBtn.count()) {
    contains('on today it still goes by who clocked in', await todayBtn.textContent(), "clocked in");
  }
  await page.evaluate(() => { planDay = null; });

  // ------------------------------------------------------- ONE BUTTON, A WEEK
  // Getting a week ready used to be level, then open each day, then check each was
  // handed round — several taps in an order you had to know.
  console.log('\n\x1b[1mONE BUTTON — the whole week ready\x1b[0m');
  const week = await page.evaluate(() => {
    // Wipe every day ahead so the button is doing all of the work.
    for (let i = 1; i <= 7; i += 1) {
      const d = shiftDay(workToday(), i);
      delete state.plans[d]; delete state.planSeeded[d];
      if (state.planDropped) delete state.planDropped[d];
    }
    const pv = planAheadPreview(7);
    const ran = runPlanAhead(7, pv.worthLevelling);
    const days = [];
    for (let i = 1; i <= 7; i += 1) {
      const d = shiftDay(workToday(), i);
      const plan = state.plans[d] || {};
      const rooms = Object.values(plan).filter((v) => v.kind === 'unit');
      days.push({ day: d, jobs: Object.keys(plan).length, rooms: rooms.length,
                  assigned: rooms.filter((v) => v.assignedTo).length,
                  rostered: cleaningStaff().filter((p) => worksOnDay(p, d)).length });
    }
    return { ran, days, levelled: pv.worthLevelling };
  });
  check('one tap lays out every day of the week', week.days.every((d) => d.jobs > 0),
    'empty days: ' + JSON.stringify(week.days.filter((d) => !d.jobs).map((d) => d.day)));
  check('and hands out the rooms on each of them',
    week.days.every((d) => !d.rooms || !d.rostered || d.assigned > 0),
    'unhanded days: ' + JSON.stringify(week.days.filter((d) => d.rooms && d.rostered && !d.assigned)));
  check('it reports what it actually did', week.ran.jobs > 0, 'reported ' + JSON.stringify(week.ran));

  // Pressing it twice must not double anything up or re-deal settled work.
  const twice = await page.evaluate(() => {
    const before = JSON.stringify(state.plans);
    const again = runPlanAhead(7, false);
    return { same: JSON.stringify(state.plans) === before, again };
  });
  check('pressing it again changes nothing', twice.same,
    'the second run altered the plans: ' + JSON.stringify(twice.again));

  // -------------------------------------------------------- LEARN THE USUALS
  // Rooms go back to their regular cleaner only if somebody tied them by hand, one
  // at a time, which is why hardly any are tied. The log already knows.
  console.log('\n\x1b[1mWHO USUALLY DOES WHAT — read from the log\x1b[0m');
  const learn = await page.evaluate(() => {
    state.rollCallTypes = null;
    const saved = JSON.parse(JSON.stringify(state.servicedUnits));
    const cleaners = (state.staff || []).filter((p) => p.isCleaner);
    const [a, b] = cleaners;
    state.servicedUnits = [
      { id: 'r1', unit: '301' },   // a does it nearly every time  → tie to a
      { id: 'r2', unit: '302' },   // shared half and half         → leave in the pool
      { id: 'r3', unit: '303' },   // a did it once                → not a pattern
      { id: 'r4', unit: '304' },   // b's, but currently tied to a → change hands
    ];
    state.servicedUnits[3].usualTo = a.id;
    const at = (n) => new Date(Date.now() - n * 864e5).toISOString();
    cleaningHistory = [
      ...[1, 3, 5, 7].map((d) => ({ unit_id: 'r1', cleaner_id: a.id, cleaner_name: a.name, cleaned_at: at(d) })),
      { unit_id: 'r1', cleaner_id: b.id, cleaner_name: b.name, cleaned_at: at(9) },
      ...[1, 3, 5].map((d) => ({ unit_id: 'r2', cleaner_id: a.id, cleaner_name: a.name, cleaned_at: at(d) })),
      ...[2, 4, 6].map((d) => ({ unit_id: 'r2', cleaner_id: b.id, cleaner_name: b.name, cleaned_at: at(d) })),
      { unit_id: 'r3', cleaner_id: a.id, cleaner_name: a.name, cleaned_at: at(2) },
      // r4 is recorded by NAME only, as the older rows in the log are.
      ...[1, 3, 5].map((d) => ({ unit_id: 'r4', cleaner_id: null, cleaner_name: b.name, cleaned_at: at(d) })),
      // Long past the window — must not count for anything.
      ...[100, 101, 102, 103].map((d) => ({ unit_id: 'r3', cleaner_id: b.id, cleaner_name: b.name, cleaned_at: at(d) })),
    ];
    const plan = learnUsualPlan(30);
    const got = (id) => (plan.proposals.find((p) => p.u.id === id) || {}).who || null;
    const out = { a: a.id, b: b.id, r1: got('r1'), r2: got('r2'), r3: got('r3'), r4: got('r4'),
                  count: plan.proposals.length };
    applyLearnedUsuals(plan);
    out.r1Tied = state.servicedUnits.find((u) => u.id === 'r1').usualTo;
    out.r4Tied = state.servicedUnits.find((u) => u.id === 'r4').usualTo;
    state.servicedUnits = saved;
    return out;
  });
  eq('a room one person nearly always does is tied to them', learn.r1, learn.a);
  eq('a room shared evenly is left in the pool to rotate', learn.r2, null);
  eq('one clean is a coincidence, not a pattern', learn.r3, null);
  eq('older rows recorded by name only still count', learn.r4, learn.b);
  eq('a room tied to the wrong person changes hands', learn.r4Tied, learn.b);
  eq('and the tie is actually written to the room', learn.r1Tied, learn.a);
  eq('nothing else is touched', learn.count, 2);

  // ------------------------------------------------------------ LEVEL A WEEK
  // Thirteen rooms one day and twenty-four the next is the same work either way,
  // but the heavy day can't be finished and the light one wastes a crew.
  console.log('\n\x1b[1mLEVEL THE WEEK — no day carries the lot\x1b[0m');
  const lvl = await page.evaluate(() => {
    state.rollCallTypes = null;
    const rooms = state.servicedUnits.filter((u) => onRollCall(u));
    // Build a deliberate pile-up: nearly every room falls due on the same day,
    // with one lonely room the day before it.
    rooms.forEach((u, i) => {
      u.freq = 'weekly'; u.paused = false;
      delete u.alsoCleanOn; delete u.holdUntil; delete u.cycleShift; delete u.cycleShiftFrom;
      delete lastCleanedByUnit[u.id];
      u.lastCleaned = shiftDay(workToday(), i === 0 ? -6 : -5);   // day 1 for one, day 2 for the rest
    });
    const plan = levelPlan(14);
    return {
      rooms: rooms.length,
      peakBefore: plan.peakBefore, peakAfter: plan.peakAfter,
      moves: plan.moves.map((m) => ({ unit: m.u.unit, from: m.from, to: m.to, kind: m.kind })),
      days: plan.days,
    };
  });
  check('the fortnight starts out lopsided', lvl.peakBefore >= 3,
    'peak was only ' + lvl.peakBefore + ' across ' + lvl.rooms + ' rooms — nothing to level');
  check('levelling brings the heaviest day down', lvl.peakAfter < lvl.peakBefore,
    'peak ' + lvl.peakBefore + ' → ' + lvl.peakAfter);
  check('it actually moves rooms to do it', lvl.moves.length > 0, 'no moves proposed');
  check('and never makes a room wait longer than it already is',
    lvl.moves.every((m) => (m.kind === 'earlier' ? m.to < m.from : m.to > m.from)),
    'offending moves: ' + JSON.stringify(lvl.moves.filter((m) =>
      !(m.kind === 'earlier' ? m.to < m.from : m.to > m.from))));
  check('nothing is moved onto today, with the round already under way',
    lvl.moves.every((m) => m.to > lvl.days[0]),
    'moved onto today: ' + JSON.stringify(lvl.moves.filter((m) => m.to <= lvl.days[0])));

  // Applying it must produce the shape it promised, not merely intend to.
  const lvlAfter = await page.evaluate(() => {
    const plan = levelPlan(14);
    const promised = plan.peakAfter;
    applyLevelPlan(plan);
    const counts = projectedCounts(14);
    return { promised, realised: Math.max(...Object.values(counts)) };
  });
  eq('the schedule really ends up as level as it promised', lvlAfter.realised, lvlAfter.promised);

  // The case this exists for: every every-other-day room falling due together, so
  // the estate swings between a huge day and an empty one for ever. There is no
  // earlier day to move any of them to — the only way to prise them apart is to
  // clean some twice, once, after which they run on the opposite day for good.
  const eodClump = await page.evaluate(() => {
    state.rollCallTypes = null;
    const saved = JSON.parse(JSON.stringify(state.servicedUnits));   // put the fixture back afterwards
    state.servicedUnits = [];
    for (let i = 1; i <= 20; i += 1) state.servicedUnits.push({
      id: 'e' + i, unit: String(100 + i), freq: 'eod', lastCleaned: shiftDay(workToday(), -1),
    });
    const before = levelPlan(14);
    applyLevelPlan(before);
    const counts = projectedCounts(14);
    const tail = Object.keys(counts).sort().slice(7).map((d) => counts[d]);
    const out = {
      settledBefore: before.settledBefore, settledAfter: before.settledAfter,
      moves: before.moves.length,
      extras: before.moves.filter((m) => m.kind === 'extra').length,
      tail,
      emptyDays: tail.filter((n) => n === 0).length,
    };
    state.servicedUnits = saved;
    return out;
  });
  check('twenty rooms falling due together is caught as lopsided', eodClump.settledBefore >= 20,
    'settled peak was ' + eodClump.settledBefore);
  check('the clump is broken up', eodClump.moves > 0, 'nothing was moved');
  check('by cleaning some of them twice, since none can be delayed', eodClump.extras > 0,
    'no extra cleans proposed — a clump due now cannot be split any other way');
  check('afterwards no day carries them all', eodClump.settledAfter <= eodClump.settledBefore / 2 + 1,
    'settled peak ' + eodClump.settledBefore + ' → ' + eodClump.settledAfter);
  eq('and there are no empty days left swinging against heavy ones', eodClump.emptyDays, 0);

  // ------------------------------------------------------------- DURABILITY
  // A save is not finished until the server has it. These cover the way changes
  // used to vanish: made on a phone, still shown on that phone, never seen by
  // any other device because the write never left the handset.
  console.log('\n\x1b[1mDURABILITY — a change must reach the server, or keep trying\x1b[0m');

  const markUnitPriority = (on) => page.evaluate((flag) => {
    const u = state.servicedUnits.find((x) => x.id === 'u101');
    u.priority = flag;
    save();
  }, on);
  const dirtyFlag = () => page.evaluate(() => localStorage.getItem(STORE + '_dirty'));

  // 1. Locking the phone right after a tap must not eat the change. The push is
  //    debounced 250ms; hiding the page has to flush it rather than kill it.
  writes.length = 0;
  await markUnitPriority(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1800);
  check('a change survives the screen being locked before the debounce fires',
    writes.length > 0, 'nothing was sent to the server');
  check('and it is the change that was actually made',
    writes.length > 0 && writes[writes.length - 1].data.servicedUnits.find((u) => u.id === 'u101').priority === true,
    'the write did not carry the edit');
  eq('the device is clean once the server has it', await dirtyFlag(), null);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // 2. A write the server refuses must be remembered, not silently dropped.
  const outageStart = consoleErrors.length;   // the 503s below are on purpose
  failWrites = true;
  writes.length = 0;
  await markUnitPriority(false);
  await page.waitForTimeout(1800);
  eq('a rejected write leaves the device marked dirty', await dirtyFlag(), '1');
  eq('nothing was recorded as written', writes.length, 0);
  contains('the crew is told it has not saved yet',
    await page.locator('#storageWarn').textContent(), 'Not saved to the server yet');

  // 3. While dirty, a live update from another device must not overwrite the
  //    change this one is still holding.
  await page.evaluate(() => applyRemote({ ...state, servicedUnits: state.servicedUnits.map((u) => ({ ...u, priority: true })) }));
  await page.waitForTimeout(300);
  eq('an unsent change is not clobbered by another device',
    await page.evaluate(() => state.servicedUnits.find((u) => u.id === 'u101').priority), false);

  // 4. When the connection comes back, the held change goes up by itself.
  failWrites = false;
  writes.length = 0;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(1800);
  check('the held change is sent as soon as the connection returns',
    writes.length > 0, 'came back online and still sent nothing');
  check('the server gets the edit, not a stale copy',
    writes.length > 0 && writes[writes.length - 1].data.servicedUnits.find((u) => u.id === 'u101').priority === false,
    'the recovered write carried the wrong value');
  eq('the device is clean again', await dirtyFlag(), null);
  check('the warning is taken down once it saves',
    await page.locator('#storageWarn').evaluate((e) => e.style.display) === 'none', 'warning still showing');

  // Drop only the 503s this section caused; anything else it logged still counts.
  consoleErrors.push(...consoleErrors.splice(outageStart).filter((e) => !/503/.test(e)));

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
