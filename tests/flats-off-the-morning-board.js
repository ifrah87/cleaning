/**
 * A GUEST FLAT NOBODY HAS BEEN GIVEN IS NOT ON THE MORNING BOARD.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/flats-off-the-morning-board.js
 *
 * The flats are a separate job: done after the offices, by whoever is free, on whoever
 * checked out — and the office picks them. So every one of the twelve went into the
 * columns whether or not anybody was holding it, which put them all in NOBODY YET as a
 * block that never emptied and made a round of twenty-four rooms read as thirty-six jobs.
 * On the wall it looked like the app was proposing a dozen flats for a morning that is
 * not theirs.
 *
 * Both halves matter, and this is the third time the line between them has moved:
 *   · UNHANDED — off the board, off the TV, out of the count. Picked up on the roll
 *     call's own Airbnb strip, which reads the rooms directly and is untouched by this.
 *   · HANDED   — on the board, in its cleaner's column, in its own colour. The wall is
 *     where "what has been done today" is read, and a flat cleaned at two o'clock has
 *     to be visible on it. Taking the flats off every screen at once was tried on
 *     26 Aug and reverted within the hour, because then they could not be ticked at all.
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
// See the note in the other fixtures: the daily rooms are cleaned on the Friday in
// advance of the Saturday, so "cleaned literally yesterday" is not due on a Saturday.
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); while (d.getDay() === 5) d.setDate(d.getDate() - 1); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const APP_STATE = {
  staff: [
    { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [1], hikPersonId: 'h1', canClean: ['building', 'office', 'airbnb'] },
    { id: 'p2', name: 'Hodan Omar', crew: 'Team B', isCleaner: true, isLeader: true, floors: [3], hikPersonId: 'h2', canClean: ['building', 'office', 'airbnb'] },
  ],
  servicedUnits: [
    { id: 'su101', unit: '101', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
    { id: 'su301', unit: '301', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p2' },
    // One flat somebody has been given, stamped as this round's decision so
    // clearStaleHandouts reads it as a name from today rather than last night's leftover.
    { id: 'su406', unit: '406', type: 'airbnb', freq: 'daily', preferLate: true, lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
    // ...and two nobody has touched, which is where the twelve normally sit.
    { id: 'su506', unit: '506', type: 'airbnb', freq: 'daily', preferLate: true, lastCleaned: DAY_BEFORE },
    { id: 'su606', unit: '606', type: 'airbnb', freq: 'daily', preferLate: true, lastCleaned: DAY_BEFORE },
  ],
  areas: [{ id: 'corridors', label: 'Corridors', kind: 'interior', freq: 'daily', assignedTo: 'p1' }],
  completions: {}, assignConfirmed: { su406: WORK_TODAY }, manualArrivals: {}, floors: 11,
  rollCallTypes: ['office', 'building'],   // as in the building: Airbnb is its own job
};
const EVENTS = [
  { person_name: 'Amina Yusuf', person_code: '1', event_time: WORK_TODAY + ' 06:30:00' },
  { person_name: 'Hodan Omar', person_code: '2', event_time: WORK_TODAY + ' 06:35:00' },
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

  console.log('\n\x1b[1mThe flats nobody has been given are not on the morning board\x1b[0m');

  // The columns are the one source the board, the roll call and the television all read,
  // so asking them is asking all three at once.
  const cols = await page.evaluate(() => tvColumns().map((c) => ({
    name: c.name, jobs: c.jobs.map((j) => ({ label: j.label, air: !!j.air })),
  })));
  const labels = (n) => (cols.find((c) => c.name.indexOf(n) === 0) || { jobs: [] }).jobs.map((j) => j.label);
  const everywhere = cols.reduce((a, c) => a.concat(c.jobs.map((j) => j.label)), []);

  check('a flat nobody holds is not in anybody’s column',
    !everywhere.some((l) => /^506/.test(l)), everywhere.join(', '));
  check('...nor waiting in NOBODY YET',
    !labels('NOBODY YET').some((l) => /^(506|606)/.test(l)), labels('NOBODY YET').join(', ') || '(no such column)');
  // 101, 301, the corridors and the one flat somebody is holding. The two nobody has
  // been given are not jobs this morning has, and the tally on the wall has to say so —
  // that number is what the office reads the round's size off.
  check('...and it is not counted as one of the morning’s jobs',
    await page.evaluate(() => countJobs(tvColumns()).all) === 4,
    JSON.stringify(await page.evaluate(() => countJobs(tvColumns()))));

  check('a flat somebody HAS been given is in their column',
    labels('Amina').some((l) => /^406/.test(l)), labels('Amina').join(', '));
  check('...and still marked as a flat, so the board colours it as one',
    (cols.find((c) => c.name.indexOf('Amina') === 0) || { jobs: [] }).jobs
      .some((j) => /^406/.test(j.label) && j.air), JSON.stringify(labels('Amina')));

  // The office picks the flats on the roll call, off the board. That strip reads the
  // rooms directly, so it must be untouched by all of the above — this is the half that
  // broke on 26 Aug, when the flats came off every screen at once.
  await page.evaluate(() => { setTab('rollcall'); render(); });
  await page.waitForTimeout(700);
  const roll = await page.locator('.body').first().textContent();
  check('every flat is still on the roll call’s Airbnb strip, to be given out',
    /🏠 Airbnb \(\d\/3 done\)/.test(roll) && /506/.test(roll) && /606/.test(roll),
    (roll.match(/🏠 Airbnb[^\n]{0,40}/) || ['no Airbnb strip'])[0]);

  // ...and the board is where one is handed over. The "give more work" list offers the
  // rooms directly too, so a flat can be put on somebody from the morning screen.
  await page.evaluate(() => { setTab('board'); render(); });
  await page.waitForTimeout(700);
  await page.locator('button.bd-more').first().click();
  await page.waitForTimeout(500);
  const give = await page.locator('.givelist').first().textContent();
  check('and the board can still hand one out', /506/.test(give), give.slice(0, 160));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
