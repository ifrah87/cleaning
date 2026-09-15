/**
 * A ROOM YOU GIVE SOMEBODY STAYS GIVEN.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/an-extra-room-stays-given.js
 *
 * "Give X more work" offers every room nobody is holding and nobody has cleaned —
 * including rooms today's schedule did not ask for, which is the point of it: the
 * office hands somebody an extra room. Handing it over wrote the room's assignedTo and
 * nothing else, and the board does not draw rooms, it draws TODAY'S LIST: what the
 * schedule says is due, plus what is on today's plan. A room that is neither is on
 * neither list, so the chip went into the column and was gone by the next render.
 *
 * The office tapped the room, watched it land, watched it vanish, tapped it again:
 * "the rooms comes up, i add it, but it dissapears".
 *
 * Giving somebody a room IS putting it on today, so it goes on today's plan, marked
 * byHand — and byHand is what stops the five-minute re-sync taking it straight back off
 * as a room the schedule never asked for.
 *
 * SAFETY: never touches the live Supabase project; every request to *.supabase.co is
 * answered from the fixtures below, and writes are discarded.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';

const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const WORK_TODAY = (() => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); return key(d); })();
// Step back past a Friday, so "cleaned the day before, due today" is true whatever day
// the suite is run — the daily rooms are cleaned on the Friday for the Saturday.
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); while (d.getDay() === 5) d.setDate(d.getDate() - 1); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1e3) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

const APP_STATE = {
  staff: [
    { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [1], hikPersonId: 'h1', canClean: ['building', 'office'] },
    { id: 'p2', name: 'Hodan Omar', crew: 'Team B', isCleaner: true, isLeader: true, floors: [2], hikPersonId: 'h2', canClean: ['building', 'office'] },
  ],
  servicedUnits: [
    { id: 'su101', unit: '101', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
    { id: 'su201', unit: '201', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p2' },
    // THE ROOM UNDER TEST. Weekly, cleaned yesterday — so the schedule does not want it
    // today and nothing put it on today's plan. It is exactly the room the hand-out list
    // offers and the board then refused to keep.
    { id: 'su801', unit: '801', type: 'office', freq: 'weekly', lastCleaned: DAY_BEFORE },
  ],
  rollCallTypes: ['office', 'building'],
  areas: [{ id: 'corridors', label: 'Corridors', kind: 'interior', freq: 'daily', assignedTo: 'p1' }],
  // Today is laid out, as it always is by the time anybody looks at the board. The room
  // under test is deliberately NOT on it.
  plans: {
    [WORK_TODAY]: {
      'unit:su101': { kind: 'unit', refId: 'su101', label: 'Unit 101', assignedTo: 'p1', auto: true },
      'unit:su201': { kind: 'unit', refId: 'su201', label: 'Unit 201', assignedTo: 'p2', auto: true },
    },
  },
  completions: {}, assignConfirmed: {}, manualArrivals: {}, attendance: {}, floors: 11,
  autoAssign: false, autoBalance: false,
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

  // The premise: 801 is not on today's round, and the hand-out list offers it anyway.
  const before = await page.evaluate(() => ({
    onTodaysList: todaysRoomList().map((u) => u.unit),
    plan: Object.keys((state.plans || {})[workToday()] || {}),
  }));
  console.log('  today\'s round  : ' + before.onTodaysList.join(', '));
  check('801 is not on today\'s round to begin with',
    !before.onTodaysList.includes('801'), before.onTodaysList.join(', '));
  check('...and not on today\'s plan either',
    !before.plan.includes('unit:su801'), before.plan.join(', '));

  // Open Amina's hand-out list and give her 801 — the two taps the office makes.
  const offered = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => /Give Amina more work/.test(b.textContent));
    if (btn) btn.click();
    return Array.from(document.querySelectorAll('.givelist .bd-job')).map((b) => b.textContent.replace(/^＋\s*/, '').trim());
  });
  await page.waitForTimeout(300);
  check('the list offers 801', offered.includes('801'), offered.join(', ') || '(nothing)');

  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.givelist .bd-job'))
      .find((x) => x.textContent.replace(/^＋\s*/, '').trim() === '801');
    if (b) b.click();
  });
  await page.waitForTimeout(900);

  const after = await page.evaluate(() => {
    const cols = Array.from(document.querySelectorAll('.bd-col')).map((c) => ({
      who: (c.querySelector('.bd-who') || {}).textContent || '',
      jobs: Array.from(c.querySelectorAll('.bd-lbl')).map((b) => b.textContent.replace(/[✓🌅\s]/g, '')),
    }));
    const amina = cols.find((c) => /Amina/.test(c.who));
    const j = ((state.plans || {})[workToday()] || {})['unit:su801'] || null;
    return {
      aminaHas: amina ? amina.jobs : null,
      onTodaysList: todaysRoomList().map((u) => u.unit),
      assignedTo: ((state.servicedUnits || []).find((u) => u.id === 'su801') || {}).assignedTo || null,
      planEntry: j && { assignedTo: j.assignedTo, byHand: !!j.byHand, auto: !!j.auto },
    };
  });
  console.log('  Amina now holds: ' + (after.aminaHas || []).join(', '));

  check('the room is on the person', after.assignedTo === 'p1', String(after.assignedTo));
  check('the room went onto today\'s plan, by hand',
    !!after.planEntry && after.planEntry.assignedTo === 'p1' && after.planEntry.byHand && !after.planEntry.auto,
    JSON.stringify(after.planEntry));
  check('today\'s round now includes it',
    after.onTodaysList.includes('801'), after.onTodaysList.join(', '));
  check('THE CHIP IS STILL ON THE BOARD after the render',
    !!after.aminaHas && after.aminaHas.includes('801'), (after.aminaHas || []).join(', '));

  // AND IT SURVIVES THE CLOCK. topUpTodayPlan runs every five minutes and brings the day
  // back in line with the schedule — which never asked for 801. byHand is what tells it
  // to leave a person's decision alone.
  const survived = await page.evaluate(() => {
    resyncPlanDay(workToday(), true);
    topUpTodayPlan();
    render();
    const amina = Array.from(document.querySelectorAll('.bd-col'))
      .find((c) => /Amina/.test((c.querySelector('.bd-who') || {}).textContent || ''));
    return {
      stillPlanned: !!((state.plans || {})[workToday()] || {})['unit:su801'],
      jobs: amina ? Array.from(amina.querySelectorAll('.bd-lbl')).map((b) => b.textContent.replace(/[✓🌅\s]/g, '')) : null,
    };
  });
  check('the top-up does not take it back off the plan', survived.stillPlanned);
  check('...nor off the board', !!survived.jobs && survived.jobs.includes('801'), (survived.jobs || []).join(', '));

  check('no console errors', errs.length === 0, errs.slice(0, 3).join('\n         '));
  await browser.close(); s.close();
  const bad = results.filter(([, ok]) => !ok);
  console.log('\n\x1b[1m' + (results.length - bad.length) + '/' + results.length + ' passed\x1b[0m');
  if (bad.length) process.exit(1);
})();
