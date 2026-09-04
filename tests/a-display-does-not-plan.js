/**
 * A DISPLAY DOES NOT PLAN.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/a-display-does-not-plan.js
 *
 * planningPass() has been guarded with `if (TV_MODE) return` since 23 Aug, and the note
 * above it says exactly why: "the television built a private plan every minute that no
 * phone and no other TV ever saw". The guard was on the CALLER, and the caller was not
 * the only way in — startDayWatch()'s five-minute interval calls topUpTodayPlan() and
 * carryPlanToBoardOnOpen() directly, and neither of those was guarded. So the wall went
 * on adding rooms to today, dealing them, and writing names onto its own copy of the
 * board, through the door next to the one that had been shut.
 *
 * And it did not wash out again on the next pull. applyRemote returns early when the
 * incoming copy is identical to the last one, so on a quiet board — which is most of the
 * day — nothing ever overwrote what the wall had invented. The office looked at a phone
 * and a television showing different rooms with different names on them.
 *
 * This drives exactly what that interval drives, on a ?tv=1 page, and asserts the board
 * changed nothing: not the plan, not the room, and not the server.
 *
 * SAFETY: never touches the live Supabase project. Every request to *.supabase.co is
 * answered from the fixture below, and any write is counted rather than sent.
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
// Not a Friday: a Friday clean is worked in advance of the Saturday, so a daily room
// cleaned then is deliberately NOT due the next morning — which would leave this test
// with nothing for the re-sync to add, for a reason that is not what it is about.
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1));
  while (d.getDay() === 5) d.setDate(d.getDate() - 1); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

// A plan for today that EXISTS — so the re-sync does not bail on an empty day, which is
// how a day cleared on purpose stays cleared — but is missing 101, which the schedule
// says is due. Any room that falls due after its day was planned looks like this.
const APP_STATE = {
  staff: [{ id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [1], hikPersonId: 'h1' }],
  servicedUnits: [
    { id: 'u1', unit: '101', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: null },
    { id: 'u2', unit: '102', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
  ],
  areas: [],
  plans: { [WORK_TODAY]: { 'unit:u2': { auto: true, kind: 'unit', label: 'Unit 102', refId: 'u2', assignedTo: 'p1' } } },
  planSeeded: { [WORK_TODAY]: true },
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  rollCallTypes: ['office', 'building'],
};

let writes = 0;
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
        const row = { data: APP_STATE, updated_at: '2026-01-01T00:00:00Z' };
        return json(single ? row : [row]);
      }
      writes += 1;                       // a board must never get here
      return json([{}], 201);
    }
    if (url.includes('/rest/v1/hik_events')) return json([]);
    if (url.includes('/rest/v1/cleaning_log')) return json([], m === 'POST' ? 201 : 200);
    return json([]);
  });
}

const out = [];
const check = (n, c, d) => { out.push([n, !!c]); console.log((c ? '  \x1b[32mPASS\x1b[0m ' : '  \x1b[31mFAIL\x1b[0m ') + n + (c || !d ? '' : '\n       ' + d)); };

(async () => {
  const { s, port } = await serve();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await routeSupabase(ctx);
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);

  const errs = [];
  const tv = await ctx.newPage();
  tv.on('console', (x) => { if (x.type() === 'error') errs.push(x.text()); });
  tv.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await tv.goto(`http://127.0.0.1:${port}/index.html?tv=1`, { waitUntil: 'domcontentloaded' });
  await tv.waitForTimeout(4000);

  const before = await tv.evaluate((d) => ({
    tv: typeof TV_MODE !== 'undefined' ? TV_MODE : null,
    jobs: Object.keys((state.plans || {})[d] || {}),
  }), WORK_TODAY);
  check('the page really is in TV mode', before.tv === true, JSON.stringify(before));
  check('the board starts on the server\'s one planned job', before.jobs.length === 1, JSON.stringify(before.jobs));

  // Exactly what startDayWatch()'s five-minute interval does, without waiting for it.
  const after = await tv.evaluate((d) => {
    const r = topUpTodayPlan();
    carryPlanToBoardOnOpen();
    return { added: r.added || 0, jobs: Object.keys((state.plans || {})[d] || {}),
      u1: ((state.servicedUnits || []).find((u) => u.id === 'u1') || {}).assignedTo || null };
  }, WORK_TODAY);
  check('the board adds no room of its own to today', after.added === 0, JSON.stringify(after));
  check('...so today\'s plan is still the server\'s', after.jobs.length === 1, JSON.stringify(after.jobs));
  check('...and no name is written onto a room', after.u1 === null, 'u1 assignedTo=' + after.u1);
  check('...and nothing was sent to the server either', writes === 0, 'writes seen: ' + writes);

  // The room IS genuinely due — the same call on a device that can save adds it. Without
  // this the test would pass just as well against an app that had stopped planning at all.
  const phone = await ctx.newPage();
  await phone.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await phone.waitForTimeout(4000);
  const onPhone = await phone.evaluate((d) => {
    topUpTodayPlan();
    return { jobs: Object.keys((state.plans || {})[d] || {}) };
  }, WORK_TODAY);
  check('a device that can save does add the room', onPhone.jobs.includes('unit:u1'), JSON.stringify(onPhone));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
