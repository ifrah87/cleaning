/**
 * WHAT THE BOARD SHOWS, THE BOARD HAS TO BE ABLE TO HAND OUT.
 *
 * The guest flats sit in NOBODY YET by design — Airbnb is its own job, cleaned after
 * the offices by two people, and the office picks which flats. But "Give X more work"
 * filtered by onRollCall, which the flats are deliberately not on, so the office could
 * see eleven flats waiting for somebody and had no way to give one of them to anybody.
 * The one column that exists to be handed out was the one column the list refused.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/board-hands-out-what-it-shows.js
 *
 * SAFETY: never touches the live Supabase project; every request is answered locally.
 */
const http = require('http'), fs = require('fs'), path = require('path');
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
const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1e3) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

const APP_STATE = {
  staff: [
    { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [1], hikPersonId: 'h1', canClean: ['building', 'office', 'airbnb'] },
    { id: 'p2', name: 'Hodan Omar', crew: 'Team B', isCleaner: true, isLeader: true, floors: [3], hikPersonId: 'h2', canClean: ['building', 'office', 'airbnb'] },
  ],
  servicedUnits: [
    { id: 'su101', unit: '101', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
    // Hodan needs a room of her own or the board gives her no column at all.
    { id: 'su201', unit: '201', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p2' },
    { id: 'su301', unit: '301', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE },   // spare office
    { id: 'su406', unit: '406', type: 'airbnb', freq: 'daily', lastCleaned: DAY_BEFORE },   // spare flat
    { id: 'su506', unit: '506', type: 'airbnb', freq: 'daily', lastCleaned: DAY_BEFORE },   // spare flat
  ],
  // Airbnb off the roll call, exactly as the live building has it.
  rollCallTypes: ['office', 'building'],
  areas: [{ id: 'corridors', label: 'Corridors', kind: 'interior', freq: 'daily', assignedTo: 'p1' }], completions: {}, assignConfirmed: {}, manualArrivals: {}, attendance: {}, plans: {}, floors: 11,
};
const EVENTS = [{ person_name: 'Amina Yusuf', person_code: '1', event_time: WORK_TODAY + ' 06:30:00' },
                { person_name: 'Hodan Omar', person_code: '2', event_time: WORK_TODAY + ' 06:35:00' }];

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
const results = [];
const check = (n, ok, d) => { results.push([n, !!ok]); console.log((ok ? '  \x1b[32mPASS\x1b[0m ' : '  \x1b[31mFAIL\x1b[0m ') + n + (ok || !d ? '' : '\n         ' + d)); };

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
      if (m === 'GET') { const single = String(req.headers()['accept'] || '').includes('pgrst.object'); return json(single ? { data: APP_STATE } : [{ data: APP_STATE }]); }
      return json([{}], 201);
    }
    if (url.includes('/rest/v1/hik_events')) return json(EVENTS);
    if (url.includes('/rest/v1/cleaning_log')) return json([], m === 'POST' ? 201 : 200);
    return json([]);
  });
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.header', { timeout: 20000 });
  await page.waitForTimeout(3000);

  await page.evaluate(() => { setTab('board'); render(); });
  await page.waitForTimeout(900);

  // Click the button the office clicks, and read the list it opens — alongside the
  // truth it is supposed to be drawn from, so the assertions do not depend on the
  // fixture's own hand-outs surviving the morning deal.
  const r = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => /more work/.test(b.textContent));
    if (btn) btn.click();
    const offered = Array.from(document.querySelectorAll('.givelist .bd-job'))
      .map((b) => b.textContent.replace(/^＋\s*/, '').trim());
    const us = (state.servicedUnits || []);
    return {
      offered,
      hadButton: !!btn,
      assigned: us.filter((u) => u.assignedTo).map((u) => u.unit),
      spare: us.filter((u) => !u.paused && !u.assignedTo && !cleanedToday(u)).map((u) => u.unit),
      flatsOffRollCall: us.filter((u) => !onRollCall(u)).map((u) => u.unit),
    };
  });
  console.log('  the list offers : ' + (r.offered.join(', ') || '(nothing)'));
  console.log('  off the roll call: ' + (r.flatsOffRollCall.join(', ') || '(none)'));

  check('the board has a hand-out button at all', r.hadButton);
  // The premise: these flats are deliberately NOT on the morning roll call, which is
  // exactly what the old filter used to reject them by.
  check('the guest flats are off the roll call, as the building has them',
    r.flatsOffRollCall.includes('406') && r.flatsOffRollCall.includes('506'),
    r.flatsOffRollCall.join(', '));
  // THE INVARIANT, not a named room: whichever rooms the morning deal happens to leave
  // spare, every one of them has to be offerable. Naming 301 made this depend on the
  // deal not taking it, which is luck, not the rule under test.
  check('everything unassigned and unfinished is offered',
    r.spare.every((u) => r.offered.includes(u)),
    'spare: ' + r.spare.join(', ') + ' · offered: ' + r.offered.join(', '));
  check('a guest flat is offered too — the board can hand out what it shows',
    r.offered.includes('406') && r.offered.includes('506'), r.offered.join(', '));
  check('nothing already handed out is offered again',
    !r.offered.some((u) => r.assigned.includes(u)),
    'offered ' + r.offered.join(', ') + ' · already on somebody: ' + (r.assigned.join(', ') || 'none'));

  check('no console errors', errs.length === 0, errs.slice(0, 3).join('\n         '));
  await browser.close(); s.close();
  const bad = results.filter(([, ok]) => !ok);
  console.log('\n\x1b[1m' + (results.length - bad.length) + '/' + results.length + ' passed\x1b[0m');
  if (bad.length) process.exit(1);
})();
