/**
 * A PLAN THAT HAS BEEN DRAWN UP IS NOT THE SCHEDULE'S TO WITHDRAW.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/a-drawn-plan-is-a-promise.js
 *
 * The levelling pass moves every-other-day rooms between the two weekday patterns, and
 * that decides whether a room is due on a given day. It was already forbidden from
 * taking a room off the day being WORKED — 24 Aug, two rooms vanished off a board the
 * crew were standing in front of. The same fault sat one day to the left and was left
 * open: Sunday 6 Sep at 22:41 a phone opened the app, the levelling ran, and 204 moved
 * from Sat/Mon/Wed onto Sun/Tue/Thu. Monday's plan had already been drawn up and read
 * through with 204 on it; the job was `auto`, the schedule no longer wanted it, and the
 * next re-sync deleted it. The office checked a correct plan at night and was handed a
 * different one in the morning.
 *
 * A day already drawn is a promise. The schedule may decide any day the office has not
 * seen yet; it may not quietly rewrite one it has.
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
  staff: [{ id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [2], hikPersonId: 'h1' }],
  servicedUnits: [
    // The room the levelling moves. Its days are set in the browser, once the app can
    // tell us which weekday tomorrow actually is.
    { id: 'su204', unit: '204', type: 'office', freq: 'eod', lastCleaned: DAY_BEFORE, usualTo: 'p1' },
    { id: 'su201', unit: '201', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, usualTo: 'p1' },
  ],
  areas: [], completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  rollCallTypes: ['office', 'building'],
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

  console.log('\n\x1b[1mThe office draws up tomorrow, then the schedule moves under it\x1b[0m');

  // Tomorrow is due to happen, and the office has drawn it up and read it: 204 is on it.
  const setUp = await page.evaluate(() => {
    const tom = shiftDay(workToday(), 1);
    const far = shiftDay(workToday(), 2);
    const u = state.servicedUnits.find((x) => x.id === 'su204');
    u.days = [dowOf(tom), dowOf(far)];            // due tomorrow AND the day after
    u.daysAuto = true;                            // the app put it on those days, not a person
    state.plans = {};
    // Tomorrow has been drawn up. The day after has NOT — nobody has looked at it.
    state.plans[tom] = { 'unit:su204': { kind: 'unit', refId: 'su204', label: 'Unit 204', assignedTo: 'p1', auto: true } };
    return { tom, far, days: u.days.slice(), dueTom: dueOnDay(u, tom), dueFar: dueOnDay(u, far) };
  });
  check('204 is on tomorrow’s plan and due there', setUp.dueTom, JSON.stringify(setUp));
  check('...and due on the day after, which nobody has drawn up yet', setUp.dueFar);

  // The levelling moves it onto the other pattern — off both of those days.
  const after = await page.evaluate(() => {
    const tom = shiftDay(workToday(), 1);
    const far = shiftDay(workToday(), 2);
    const u = state.servicedUnits.find((x) => x.id === 'su204');
    const other = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== dowOf(tom) && d !== dowOf(far) && d !== 5);
    keepTodayThroughDayChange(u, () => { u.days = other; });
    const job = () => (state.plans[tom] || {})['unit:su204'];
    const before = { kept: !!(job() && job().keep), dueTom: dueOnDay(u, tom), dueFar: dueOnDay(u, far) };
    const r = resyncPlanDay(tom);                 // the pass that used to delete it
    return { ...before, stillThere: !!job(), removed: r.removed, days: u.days.slice(), tom, far };
  });

  check('the schedule no longer wants 204 tomorrow', !after.dueTom, JSON.stringify(after.days));
  check('...but the drawn job is marked to be kept', after.kept, JSON.stringify(after));
  check('...and the re-sync leaves it on the plan', after.stillThere && after.removed === 0,
    'stillThere=' + after.stillThere + ' removed=' + after.removed);

  // The whole point of levelling still has to work: a day nobody has drawn up yet
  // follows the new pattern, so the week can still be levelled going forward.
  const far = await page.evaluate(() => {
    const f = shiftDay(workToday(), 2);
    const u = state.servicedUnits.find((x) => x.id === 'su204');
    return { due: dueOnDay(u, f), drawn: !!(state.plans[f] || {})['unit:su204'] };
  });
  check('a day nobody has drawn up yet follows the new pattern', !far.due && !far.drawn, JSON.stringify(far));

  // And the day being worked keeps its existing protection.
  const today = await page.evaluate(() => {
    const u = state.servicedUnits.find((x) => x.id === 'su201');
    const d = workToday();
    const wasDue = dueOnDay(u, d);
    keepTodayThroughDayChange(u, () => { u.days = [(dowOf(d) + 1) % 7]; });
    return { wasDue, alsoCleanOn: u.alsoCleanOn, dueNow: dueOnDay(u, d) };
  });
  check('a room taken off today is still given today', today.wasDue && today.dueNow && today.alsoCleanOn, JSON.stringify(today));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
