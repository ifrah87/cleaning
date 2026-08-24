/**
 * WORK THAT IS NOT A ROOM AND NOT A ROUND.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/one-off-jobs.js
 *
 * The electrician is coming; two flats are being cleaned off site. The office recorded
 * these by adding a communal area, which is a standing job — so it came round every
 * morning afterwards until somebody deleted it by hand. A one-off belongs to the day it
 * was raised, goes to somebody, ticks off with everything else, and then leaves.
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
  staff: [{ id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [1], hikPersonId: 'h1' }],
  servicedUnits: [{ id: 'su101', unit: '101', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' }],
  areas: [
    { id: 'corridors', label: 'Corridors', kind: 'interior', freq: 'daily', assignedTo: 'p1' },
    // Raised yesterday and never ticked. Work nobody got to is still work.
    { id: 'oldjob', label: 'Move the pallets', kind: 'interior', freq: 'daily', assignedTo: 'p1', oneOff: DAY_BEFORE },
    // Raised yesterday and finished. Its place is History, not tomorrow's board.
    { id: 'donejob', label: 'Plumber', kind: 'interior', freq: 'daily', assignedTo: 'p1', oneOff: DAY_BEFORE, doneOn: DAY_BEFORE },
  ],
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
};
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

  console.log('\n\x1b[1mA one-off job belongs to its day\x1b[0m');

  // The morning set-up lives behind ☰ now — the board is the screen you land on.
  await page.evaluate(() => {
    setTab('rollcall');
    // The one-off form sits with the communal walks, which fold shut by default.
    state.rcFold = Object.assign({}, state.rcFold, { areas: true });
    render();
  });
  await page.waitForTimeout(700);

  const start = await page.evaluate(() => areasInterior().map((a) => a.label));
  check('yesterday’s unfinished job is still on the board', start.includes('Move the pallets'), start.join(', '));
  check('yesterday’s finished job has left it', !start.includes('Plumber'), start.join(', '));

  // Raise one from the roll call, handed to the leader who is in.
  const raised = await page.evaluate(() => {
    addOneOffJob('Electrician', 'p1');
    const a = state.areas.find((x) => x.label === 'Electrician');
    const job = tvColumns().flatMap((c) => c.jobs).find((j) => j.label === 'Electrician');
    return { exists: !!a, oneOff: a && a.oneOff, who: a && a.assignedTo, onBoard: !!job, day: workToday() };
  });
  check('a one-off can be raised and handed to somebody', raised.exists && raised.who === 'p1', JSON.stringify(raised));
  check('it is stamped with the day it was raised', raised.oneOff === raised.day, String(raised.oneOff));
  check('and it shows in that person’s column on the board', raised.onBoard === true, JSON.stringify(raised));

  await page.waitForTimeout(400);
  const shown = await page.locator('.body').first().textContent();
  check('the phone shows it too', shown.includes('Electrician'), 'not found on the roll call');
  check('with a way to raise the next one', shown.includes('Something else today'), 'the form is missing');

  // Tick it off: finished is finished, and tomorrow it is gone.
  const ticked = await page.evaluate(() => {
    const a = state.areas.find((x) => x.label === 'Electrician');
    toggleAreaDone(a.id);
    const after = state.areas.find((x) => x.label === 'Electrician');
    return { done: areaDone(after), doneOn: after.doneOn || null, day: workToday() };
  });
  check('ticking it marks it done', ticked.done === true, JSON.stringify(ticked));
  check('and records the day it was finished', ticked.doneOn === ticked.day, JSON.stringify(ticked));

  const gone = await page.evaluate(() => {
    // Come back tomorrow: the job was raised and finished yesterday.
    const a = state.areas.find((x) => x.label === 'Electrician');
    // A day BEFORE the work day, not before the calendar day: run this between midnight
    // and the 3am cutoff and "yesterday" by the clock is still today's round.
    const y = new Date(workToday() + 'T00:00:00'); y.setDate(y.getDate() - 1);
    a.oneOff = a.doneOn = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
    return areasInterior().map((x) => x.label);
  });
  check('a finished one-off leaves the board the next day', !gone.includes('Electrician'), gone.join(', '));
  check('a standing area is untouched by any of it', gone.includes('Corridors'), gone.join(', '));
  // A PAUSED ROOM IS OFF THE BOARD — 906 went on a long lease and stayed in a column.
  const paused = await page.evaluate(() => {
    const u = state.servicedUnits.find((x) => x.unit === '101');
    const before = todaysRoomList().some((x) => x.unit === '101');
    u.paused = true; save();
    return { before, after: todaysRoomList().some((x) => x.unit === '101'),
             onBoard: tvColumns().flatMap((c) => c.jobs).some((j) => j.label === '101') };
  });
  check('a room is on today’s list to start with', paused.before === true, JSON.stringify(paused));
  check('pausing it takes it off today’s list', paused.after === false, JSON.stringify(paused));
  check('and out of its cleaner’s column on the board', paused.onBoard === false, JSON.stringify(paused));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
