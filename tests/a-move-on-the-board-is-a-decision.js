/**
 * MARKING SOMEBODY SICK MEANS THE SAME THING TO EVERY PASS.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/a-move-on-the-board-is-a-decision.js
 *
 * The office runs the morning from a phone: somebody rings in sick, they are marked
 * sick, and "Off — share out" deals their rooms round whoever is actually in. That part
 * worked. What undid it was resyncPlanDay's re-pin loop, which put every room back on
 * its `usualTo` cleaner — with no check that the cleaner was on the rota, in the
 * building, or even able to take the room. autoPlanDay and assignNewPlanJobs had all
 * asked those questions for months; this one had never been told.
 *
 * And it runs on a timer (topUpTodayPlan, every five minutes), so nobody had to touch
 * anything: the rooms simply walked back onto the person at home a few minutes after
 * being shared out, again and again. From the office end that is the app refusing to
 * believe somebody is sick.
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
    { id: 'pSick', name: 'Hodan Sick', crew: 'Team A', isCleaner: true, isLeader: true, floors: [2], hikPersonId: 'h1' },
    { id: 'pWell', name: 'Warsame Well', crew: 'Team B', isCleaner: true, isLeader: true, floors: [3], hikPersonId: 'h2' },
  ],
  // Both rooms are TIED to the person who will call in sick. That is the case that broke:
  // an untied room shares out and stays shared out.
  servicedUnits: [
    { id: 'su201', unit: '201', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, usualTo: 'pSick', assignedTo: 'pSick' },
    { id: 'su202', unit: '202', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, usualTo: 'pSick', assignedTo: 'pSick' },
    // ...and one tied to nobody, which is the case that shares out cleanly.
    { id: 'su203', unit: '203', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'pSick' },
  ],
  areas: [], completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  rollCallTypes: ['office', 'building'],
};
const EVENTS = [
  { person_name: 'Hodan Sick', person_code: '1', event_time: WORK_TODAY + ' 06:30:00' },
  { person_name: 'Warsame Well', person_code: '2', event_time: WORK_TODAY + ' 06:32:00' },
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

  console.log('\n\x1b[1mA room moved on the board stays moved\x1b[0m');

  // 201 and 202 are TIED to pSick, who is present and perfectly able to take them.
  // This is the ordinary case: the office moves a room anyway, because they are there
  // and they know something the schedule does not.
  const moved = await page.evaluate(() => {
    const day = workToday();
    const plan = getPlan(day);
    ['su201', 'su202'].forEach((id, i) => {
      plan['unit:' + id] = { kind: 'unit', refId: id, label: 'Unit 20' + (i + 1), assignedTo: 'pSick', auto: true };
    });
    setUnitAssignee('su201', 'pWell');          // exactly what a drag on the board calls
    return {
      board: (state.servicedUnits.find((u) => u.id === 'su201') || {}).assignedTo,
      plan: plan['unit:su201'].assignedTo,
      byHand: !!plan['unit:su201'].byHand,
    };
  });
  check('the board takes the move', moved.board === 'pWell', JSON.stringify(moved));
  check('...and the plan hears about it', moved.plan === 'pWell', JSON.stringify(moved));
  check('...recorded as a person\'s decision', moved.byHand, JSON.stringify(moved));

  // The five-minute top-up, which is what kept undoing it.
  const afterTimer = await page.evaluate(() => {
    topUpTodayPlan();
    const plan = getPlan(workToday());
    return { plan: plan['unit:su201'].assignedTo,
      board: (state.servicedUnits.find((u) => u.id === 'su201') || {}).assignedTo,
      untouched: plan['unit:su202'].assignedTo };
  });
  check('the timer does not put it back on the pinned cleaner',
    afterTimer.plan === 'pWell' && afterTimer.board === 'pWell', JSON.stringify(afterTimer));

  const afterMore = await page.evaluate(() => {
    topUpTodayPlan(); topUpTodayPlan(); topUpTodayPlan();
    return getPlan(workToday())['unit:su201'].assignedTo;
  });
  check('...however many times it runs', afterMore === 'pWell', String(afterMore));

  // A room nobody moved must still go to its pinned cleaner — the pin still works.
  check('a room nobody touched still sits with its pin', afterTimer.untouched === 'pSick',
    String(afterTimer.untouched));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
