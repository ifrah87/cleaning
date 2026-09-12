/**
 * SOMEBODY AT ANOTHER BUILDING CANNOT BE GIVEN A ROOM IN THIS ONE.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/offsite-gets-no-rooms-here.js
 *
 * mayGiveRoomTo is the gate every hand-out goes through — the morning deal, the
 * plan-a-day passes and the five-minute re-sync all ask it. It asked whether a person
 * was on the roster, on the crew, off the auto-deal and cleared for the kind of room.
 * Four questions, and none of them was "where is he".
 *
 * So a cleaner sent to M.Xarbi or 2 Dhagax for the day went on being dealt rooms in the
 * tower, and the only way the office had to stop it was to untick Cleaner on his card —
 * which takes him off the crew altogether and hides his site rota, his column and his
 * badge-in with it. Hassan Mohamed Elmi on 12 Sep is the case: offsite, and still
 * holding 1002.
 *
 * A site rota says where a man IS. He is at work, at another property — not away, not
 * off — so it belongs with the other four questions.
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
const DOW = new Date(WORK_TODAY + 'T00:00:00').getDay();
const TOMORROW_DOW = (DOW + 1) % 7;

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

const APP_STATE = {
  sites: [{ id: 's1', name: '2 Dhagax' }],
  staff: [
    // At another building TODAY, and on this building's crew — which is the whole point:
    // he is a cleaner here on the days he is here.
    { id: 'pOff', name: 'Hassan Elmi', crew: 'Team A', isCleaner: true, isLeader: true,
      floors: [1], hikPersonId: 'h1', siteOn: { [DOW]: ['s1'] } },
    { id: 'pHere', name: 'Mahad Hussein', crew: 'Team B', isCleaner: true, isLeader: true, floors: [3], hikPersonId: 'h2' },
  ],
  servicedUnits: [
    { id: 'u105', unit: '105', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pOff' },
    { id: 'u301', unit: '301', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pHere' },
  ],
  areas: [], completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  autoAssign: false, autoBalance: false, autoConfirm: true,
  rollCallTypes: ['office', 'building'],
};
const EVENTS = [
  { person_name: 'Hassan Elmi', person_code: '1', event_time: WORK_TODAY + ' 06:00:00' },
  { person_name: 'Mahad Hussein', person_code: '2', event_time: WORK_TODAY + ' 06:05:00' },
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

  console.log('\n\x1b[1mOffsite gets no rooms here\x1b[0m');

  const q = await page.evaluate(() => {
    const u105 = state.servicedUnits.find((u) => u.unit === '105');
    const u301 = state.servicedUnits.find((u) => u.unit === '301');
    return {
      offsiteToday: !!siteToday(state.staff.find((p) => p.id === 'pOff')),
      ownRoom: mayGiveRoomTo(u105, 'pOff'),
      otherRoom: mayGiveRoomTo(u301, 'pOff'),
      hereGetsHis: mayGiveRoomTo(u301, 'pHere'),
      onCrew: !!state.staff.find((p) => p.id === 'pOff').isCleaner,
    };
  });
  check('the app knows he is at another building today', q.offsiteToday, JSON.stringify(q));
  check('...and will not give him a room here, not even his own pinned one',
    q.ownRoom === false && q.otherRoom === false, JSON.stringify(q));
  check('...without taking him off the crew to do it', q.onCrew, JSON.stringify(q));
  check('somebody who is in this building still gets his rooms', q.hereGetsHis, JSON.stringify(q));

  // A SITE ROTA IS A DIARY, NOT A STATUS. He is elsewhere today and here tomorrow, and
  // the plan for tomorrow has to know the difference — which is why the day is passed.
  const tomorrow = await page.evaluate((dow) => {
    const p = state.staff.find((x) => x.id === 'pOff');
    p.siteOn = { [dow]: ['s1'] };                 // offsite TOMORROW instead
    const u105 = state.servicedUnits.find((u) => u.unit === '105');
    return {
      today: mayGiveRoomTo(u105, 'pOff', workToday()),
      tomorrow: mayGiveRoomTo(u105, 'pOff', shiftDay(workToday(), 1)),
    };
  }, TOMORROW_DOW);
  check('a man offsite tomorrow may still be given rooms today', tomorrow.today, JSON.stringify(tomorrow));
  check('...and may not be given them on the day he is away', tomorrow.tomorrow === false, JSON.stringify(tomorrow));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
