/**
 * A ROOM THE OFFICE IS NOT CLEANING, WITHOUT LOSING WHAT IT KNOWS ABOUT IT.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/a-room-can-stop-taking-cleaning.js
 *
 * `paused` is read in a dozen places — the roll call, today's list, the plan, the
 * hand-out, the floor map, the levelling — and every one of them honours it. Nothing in
 * the app ever SET it. The field arrived with 906 going on a long lease and has been
 * carried through the merge ever since, reachable only by editing the data directly,
 * which is no use to the office at eight in the morning when 801 says it is not taking
 * cleaning this month.
 *
 * The alternative was Remove, which forgets the room's days, its frequency, its usual
 * cleaner and its history — so a suite that comes back in three weeks has to be rebuilt
 * from nothing.
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
    { id: 'pNur', name: 'Mahamed Nur', crew: 'Team F', isCleaner: true, isLeader: true, floors: [7, 8], hikPersonId: 'h1' },
  ],
  servicedUnits: [
    // The suite that has stopped taking cleaning, holding everything worth keeping.
    { id: 'u801', unit: '801', type: 'office', freq: 'daily', days: [6, 1, 3], lastCleaned: PREV,
      usualTo: 'pNur', assignedTo: 'pNur', assignedWith: null },
    { id: 'u702', unit: '702', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pNur', assignedTo: 'pNur' },
  ],
  areas: [], completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  autoAssign: false, autoBalance: false, autoConfirm: true,
  rollCallTypes: ['office', 'building'],
};
const EVENTS = [{ person_name: 'Mahamed Nur', person_code: '1', event_time: WORK_TODAY + ' 06:00:00' }];

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

  console.log('\n\x1b[1mA room can stop taking cleaning\x1b[0m');

  const before = await page.evaluate(() => ({
    onList: todaysRoomList().some((u) => u.unit === '801'),
  }));
  check('the room is on today’s list to begin with', before.onList, JSON.stringify(before));

  const after = await page.evaluate(() => {
    toggleUnitPaused('u801');
    const u = state.servicedUnits.find((x) => x.unit === '801');
    return {
      paused: !!u.paused,
      keptDays: JSON.stringify(u.days || null),
      keptUsual: u.usualTo || null,
      keptFreq: u.freq || null,
      stillOnRoster: !!u,
      held: u.assignedTo,
      onList: todaysRoomList().some((x) => x.unit === '801'),
      onBoard: tvColumns().some((c) => c.jobs.some((j) => /^801/.test(j.label))),
      inFloorMap: JSON.stringify((floorOwnerProposal().find((r) => r.floor === 8) || {}).counts || {}),
      other: todaysRoomList().some((x) => x.unit === '702'),
    };
  });

  check('pausing takes it off today’s list', after.paused && !after.onList, JSON.stringify(after));
  check('...and off the board, rather than stranding it on a name',
    !after.onBoard && after.held === null, JSON.stringify(after));
  check('...and out of the floor map’s reckoning',
    after.inFloorMap === '{}', after.inFloorMap);
  check('...while keeping its days, its frequency and its cleaner',
    after.keptDays === '[6,1,3]' && after.keptFreq === 'daily' && after.keptUsual === 'pNur',
    JSON.stringify(after));
  check('...and leaving every other room alone', after.other, JSON.stringify(after));

  const back = await page.evaluate(() => {
    toggleUnitPaused('u801');
    const u = state.servicedUnits.find((x) => x.unit === '801');
    return { paused: !!u.paused, onList: todaysRoomList().some((x) => x.unit === '801'), usual: u.usualTo };
  });
  check('and it comes back exactly as it was',
    !back.paused && back.onList && back.usual === 'pNur', JSON.stringify(back));

  // The office has to be able to reach it — the field was honoured everywhere and
  // settable nowhere, which is the whole reason this exists.
  await page.evaluate(() => setTab('rooms'));
  await page.waitForTimeout(300);
  await page.evaluate(() => { state.roomsFilter = 'office'; render(); });
  await page.waitForTimeout(400);
  const control = await page.evaluate(() => ({
    hit: [].slice.call(document.querySelectorAll('button')).some((b) => /Pause|Not cleaning/.test(b.textContent)),
    tab: state.tab, filter: state.roomsFilter,
    cards: document.querySelectorAll('.su-rm').length,
    btns: [].slice.call(document.querySelectorAll('.freqmini')).slice(0, 14).map((b) => b.textContent),
  }));
  check('there is a control on the room to do it with', control.hit, JSON.stringify(control));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
