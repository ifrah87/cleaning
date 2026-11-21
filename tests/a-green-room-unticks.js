/**
 * A GREEN ROOM UNTICKS ON A TAP.
 *
 * 21 Nov: 403 sat green on Mahad, who had not badged in. Tapping it did nothing and,
 * being "cleaned", it could not be moved. The board calls a room cleaned when it is
 * ticked OR its last-cleaned date is today, but the tap only cleared the tick and only
 * put the date back from an undo kept on the device that ticked it. A room cleaned by
 * date alone flipped a hidden tick on and off underneath and stayed green for ever.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/a-green-room-unticks.js
 *
 * SAFETY: never touches the live Supabase project; every request is answered locally.
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';
const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
// THE WORK DAY, NOT THE CALENDAR DAY — the app's day turns over at 3am.
const WORK_TODAY = (() => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); return key(d); })();
// NOT A FRIDAY, EVER. "Cleaned the day before" is how nearly every fixture here makes a
// room due today — and the daily rooms are cleaned on the Friday in advance of the
// Saturday, so on a Saturday that clean covers today and the room is deliberately NOT
// due. A fixture pinned to literal yesterday therefore passes six days a week and fails
// on the seventh, taking the board, the hand-out and the levelling tests down with it
// for reasons that have nothing to do with what they are testing. Step back past a
// Friday so "recently cleaned, due today" means that whatever day the suite is run.
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); while (d.getDay() === 5) d.setDate(d.getDate() - 1); return key(d); })();

// A Friday comfortably in the future, so every date the schedule is questioned about
// is on the same side of "today" whatever day this test is run on. The carry-forward
// for outstanding work only applies up to today, and mixing the two sides of that
// line is how a schedule test comes out differently on a Tuesday.
const FRI = (() => { const d = new Date(WORK_TODAY + 'T12:00:00'); d.setDate(d.getDate() + 8); while (d.getDay() !== 5) d.setDate(d.getDate() + 1); return key(d); })();
const shift = (day, n) => { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() + n); return key(d); };
const THU = shift(FRI, -1), SAT = shift(FRI, 1), SUN = shift(FRI, 2), MON = shift(FRI, 3);

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1e3) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

const EARLIER = shift(WORK_TODAY, -3);
const APP_STATE = {
  staff: [{ id: 'p1', name: 'Mahad', crew: 'Lead', isCleaner: true, isLeader: false, noAuto: true, floors: [] }],
  teams: [{ name: 'Lead', color: '#0284c7', floors: [] }],
  servicedUnits: [
    // Cleaned by date only — no tick, no undo on this device. The 403 case.
    { id: 'q403', unit: '403', type: 'office', freq: 'daily', assignedTo: 'p1', lastCleaned: WORK_TODAY, lastCleanedBy: 'p1', lastCleanedByName: 'Mahad' },
    // Ticked here the ordinary way, to show that still works.
    { id: 'q701', unit: '701', type: 'office', freq: 'daily', assignedTo: 'p1', lastCleaned: EARLIER },
  ],
  floors: 11, completions: {}, assignConfirmed: {}, manualArrivals: {}, attendance: {}, plans: {},
  autoAssign: false, autoBalance: false, autoConfirm: true, rollCallTypes: ['office'],
};
const LOG = [
  { id: 'L-today', unit_id: 'q403', unit_label: '403', cleaner_id: 'p1', cleaner_name: 'Mahad', cleaned_at: WORK_TODAY + 'T09:00:00' },
  { id: 'L-before', unit_id: 'q403', unit_label: '403', cleaner_id: 'p9', cleaner_name: 'Adan', cleaned_at: EARLIER + 'T10:00:00' },
];
const deleted = [];

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
    if (url.includes('/rest/v1/hik_events')) return json([]);
    if (url.includes('/rest/v1/cleaning_log')) {
      if (m === 'DELETE') { const id = decodeURIComponent((url.match(/id=eq\.([^&]+)/) || [])[1] || ''); deleted.push(id); return json([], 200); }
      if (m === 'POST') return json([{ id: 'L-new' }], 201);
      return json(LOG.filter((r) => !deleted.includes(r.id)));
    }
    return json([]);
  });
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.header', { timeout: 20000 });
  await page.waitForTimeout(3000);

  const before = await page.evaluate(() => cleanedToday(state.servicedUnits.find((x) => x.id === 'q403')));
  check('403 starts green: cleaned by date, no tick', before);

  const after = await page.evaluate(() => {
    toggleServicedDone('q403');
    const u = state.servicedUnits.find((x) => x.id === 'q403');
    return { done: cleanedToday(u), last: u.lastCleaned, by: u.lastCleanedByName, ticked: servicedDone('q403') };
  });
  check('one tap and it is no longer cleaned', !after.done, JSON.stringify(after));
  check('...and no hidden tick was left behind', !after.ticked, JSON.stringify(after));
  check('its last clean goes back to the one before today', after.last === EARLIER && after.by === 'Adan', JSON.stringify(after));
  await page.waitForTimeout(500);
  check("today's history entry is taken out, the earlier one kept", deleted.includes('L-today') && !deleted.includes('L-before'), JSON.stringify(deleted));

  const again = await page.evaluate(() => {
    toggleServicedDone('q403');
    const u = state.servicedUnits.find((x) => x.id === 'q403');
    return cleanedToday(u);
  });
  check('a second tap ticks it again', again);

  const plain = await page.evaluate(() => {
    toggleServicedDone('q701');
    const on = cleanedToday(state.servicedUnits.find((x) => x.id === 'q701'));
    toggleServicedDone('q701');
    const u = state.servicedUnits.find((x) => x.id === 'q701');
    return { on, off: cleanedToday(u), last: u.lastCleaned };
  });
  check('an ordinary tick and untick still work', plain.on && !plain.off, JSON.stringify(plain));
  check('...and put the room back to its earlier date', plain.last === EARLIER, JSON.stringify(plain));
  check('no console errors', errs.length === 0, errs.join(' | '));

  const failed = results.filter((r) => !r[1]).length;
  console.log((results.length - failed) + ' passed, ' + failed + ' failed');
  await browser.close(); s.close();
  process.exit(failed ? 1 : 0);
})();
