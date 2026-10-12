/**
 * Leaving times typed by the office.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/out-time-by-hand.js
 *
 * The door only ever sees the crew arrive, so the office types the leaving time in on
 * Roll Call. A typed time fills the gap; a real out punch from the door is never
 * overwritten and offers no box to overwrite it with.
 *
 * SAFETY: never touches the live Supabase project. Every *.supabase.co request is
 * answered from the fixtures below; writes are swallowed.
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';
const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const WORK_TODAY = (() => { const d = new Date(); if (d.getHours() < 3) d.setDate(d.getDate() - 1); return key(d); })();
const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1e3) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

const STAFF = [
  { id: 'p1', name: 'Hodan Omar', crew: 'Team A', isCleaner: true, isLeader: true, floors: [], hikCode: '11' },
  { id: 'p2', name: 'Amina Yusuf', crew: 'Team B', isCleaner: true, isLeader: true, floors: [], hikCode: '12' },
];
const APP_STATE = {
  staff: STAFF, teams: [{ name: 'Team A', color: '#0284c7', floors: [] }, { name: 'Team B', color: '#15803d', floors: [] }],
  servicedUnits: [], floors: 11, completions: {}, assignConfirmed: {}, manualArrivals: {}, attendance: {}, plans: {}, tab: 'rollcall',
};
// Hodan only badged in. Amina badged in AND out — the door has her leaving time.
const EVENTS = [
  { person_name: 'Hodan Omar', person_code: '11', event_time: WORK_TODAY + ' 06:40:00' },
  { person_name: 'Amina Yusuf', person_code: '12', event_time: WORK_TODAY + ' 06:45:00' },
  { person_name: 'Amina Yusuf', person_code: '12', event_time: WORK_TODAY + ' 16:10:00' },
];

function serve() {
  return new Promise((r) => {
    const s = http.createServer((q, res) => {
      const f = q.url.split('?')[0] === '/' ? '/index.html' : q.url.split('?')[0];
      const p = path.join(ROOT, f);
      if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'text/plain' });
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
    if (url.includes('/rest/v1/hik_events')) return json(m === 'GET' ? EVENTS : [{}]);
    return json([]);
  });
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  const noise = (t) => /realtime\/v1\/websocket|ERR_NAME_NOT_RESOLVED/.test(t);
  page.on('console', (x) => { if (x.type() === 'error' && !noise(x.text())) errs.push(x.text()); });
  page.on('pageerror', (e) => { if (!noise(e.message)) errs.push('pageerror: ' + e.message); });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.header', { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.evaluate(async () => { setTab('rollcall'); await loadHikArrivals(); render(); });
  await page.waitForTimeout(400);

  const card = (name) => page.locator('.person', { hasText: name }).first();
  const txt = async (name) => (await card(name).innerText()).replace(/\s+/g, ' ');

  console.log('\n\x1b[1mThe office types a leaving time\x1b[0m');
  check('Hodan reads "still in" before anything is typed', /In 6:40 AM · still in/.test(await txt('Hodan')), await txt('Hodan'));
  await card('Hodan').getByRole('button', { name: /Out time/ }).click();
  await card('Hodan').locator('input[type="time"]').fill('16:05');
  // The minute's re-render must not throw the half-typed time away.
  await page.evaluate(async () => { await loadHikArrivals(); render(); });
  check('a re-render keeps the typed time', (await card('Hodan').locator('input[type="time"]').inputValue()) === '16:05');
  await card('Hodan').getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(400);
  check('Hodan now reads Out 4:05 PM (office)', /In 6:40 AM · Out 4:05 PM \(office\)/.test(await txt('Hodan')), await txt('Hodan'));
  const stored = await page.evaluate((d) => state.manualDepartures[d] && state.manualDepartures[d].p1, WORK_TODAY);
  check('stored under the work day', stored && stored.raw === WORK_TODAY + ' 16:05', JSON.stringify(stored));

  console.log('\n\x1b[1mThe door wins\x1b[0m');
  check('Amina shows the door\'s out time', /In 6:45 AM · Out 4:10 PM/.test(await txt('Amina')) && !/office/.test(await txt('Amina')), await txt('Amina'));
  check('...and offers no box to overwrite it', (await card('Amina').getByRole('button', { name: /Out time/ }).count()) === 0);
  await page.evaluate((d) => { state.manualDepartures[d].p2 = { time: '5:30 PM', raw: d + ' 17:30' }; }, WORK_TODAY);
  await page.evaluate(async () => { await loadHikArrivals(); render(); });
  check('a typed time never replaces a door punch', /Out 4:10 PM/.test(await txt('Amina')), await txt('Amina'));

  console.log('\n\x1b[1mTaking it back off\x1b[0m');
  await card('Hodan').getByRole('button', { name: '✕' }).click();
  await page.waitForTimeout(400);
  check('Hodan is back to "still in"', /still in/.test(await txt('Hodan')), await txt('Hodan'));

  check('no page errors', errs.length === 0, errs.join('\n'));
  await browser.close(); s.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
