/**
 * THE STANDING ROUNDS, ON THE WALL.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/the-rounds-on-the-wall.js
 *
 * Every page this board has shown is about a DAY — today's hand-out, tomorrow's plan,
 * the month's shape. None of them answers the question the crew actually asks between
 * mornings: whose room is 704? That answer lives in the pins, is edited one room card at
 * a time on a phone, and has never been visible from the floor at all — so a round could
 * drift for weeks and the only symptom was somebody standing in a corridor asking
 * whether it was theirs.
 *
 * Read from usualTo, not from who is holding a room this morning. That is the whole
 * difference between this page and the board beside it: one is the arrangement, the
 * other is today.
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

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const APP_STATE = {
  staff: [
    { id: 'pAbdullahi', name: 'Abdullahi Mohamed Abdi', crew: 'Team C', isCleaner: true, isLeader: true, floors: [1, 2], hikPersonId: 'h1' },
    { id: 'pAbukar', name: 'Abukar Daud Osman', crew: 'Team H', isCleaner: true, hikPersonId: 'h2' },
    { id: 'pAbiker', name: 'Mahamed Abdi Abiker', crew: 'Team H', isCleaner: true, hikPersonId: 'h3' },
    { id: 'pSick', name: 'Sadaaq Ali Abdi', crew: 'Team D', isCleaner: true, isLeader: true, floors: [4], hikPersonId: 'h4' },
  ],
  servicedUnits: [
    { id: 'u105', unit: '105', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbdullahi' },
    { id: 'u201', unit: '201', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbdullahi' },
    // The pair's round: both named on every room, which is what makes them one round.
    { id: 'u802', unit: '802', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbukar', assignedWith: ['pAbiker'] },
    { id: 'u803', unit: '803', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbukar', assignedWith: ['pAbiker'] },
    // Sadaaq's, and being covered by somebody else this morning — the page must still
    // say it is his, because the arrangement has not changed.
    { id: 'u401', unit: '401', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pSick', assignedTo: 'pAbukar' },
    // A morning room, which is the one standing fact the crew plans around.
    { id: 'u1005', unit: '1005', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbdullahi', preferEarly: true },
    // Nobody keeps it.
    { id: 'u999', unit: '999', type: 'office', freq: 'daily', lastCleaned: PREV },
    // Off the rota entirely, so not part of any round.
    { id: 'u801', unit: '801', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbukar', paused: true },
  ],
  areas: [], completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  autoAssign: false, autoBalance: false, autoConfirm: true,
  rollCallTypes: ['office', 'building'],
};
const EVENTS = APP_STATE.staff.map((p, i) => ({ person_name: p.name, person_code: String(i + 1), event_time: WORK_TODAY + ' 06:0' + i + ':00' }));

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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
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
  await page.goto(`http://127.0.0.1:${port}/index.html?tv=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tv-col', { timeout: 20000 });
  await page.waitForTimeout(2500);

  console.log('\n\x1b[1mThe rounds on the wall\x1b[0m');

  const model = await page.evaluate(() => {
    const r = tvRounds();
    return {
      rounds: r.rounds.map((x) => ({
        who: [x.person].concat(x.mates).map((p) => p.name).join(' / '),
        rooms: x.rooms.map((u) => u.unit), floors: x.floors,
      })),
      loose: r.loose.map((u) => u.unit),
    };
  });
  const dump = JSON.stringify(model);
  const find = (re) => model.rounds.find((x) => re.test(x.who));

  check('a round is read from the pins, not from this morning',
    !!find(/Sadaaq/) && find(/Sadaaq/).rooms.join() === '401', dump);
  check('two people named on every room of a round are one round',
    !!find(/Abukar/) && /Abukar Daud Osman \/ Mahamed Abdi Abiker/.test(find(/Abukar/).who), dump);
  check('...and that round is drawn once, not once per name',
    model.rounds.filter((x) => /Abiker/.test(x.who)).length === 1, dump);
  check('a room nobody keeps is called out on its own', model.loose.join() === '999', dump);
  check('a room off the rota is on nobody’s round',
    !model.rounds.some((x) => x.rooms.indexOf('801') >= 0) && model.loose.indexOf('801') < 0, dump);
  check('the rounds run up the building, lowest floor first',
    model.rounds[0].floors[0] <= model.rounds[model.rounds.length - 1].floors[0], dump);

  // ...and it is reachable from the remote, which is the only way anybody gets to it.
  const walk = await page.evaluate(async () => {
    const seen = [];
    for (let i = 0; i < 6; i += 1) {
      seen.push((document.querySelector('.tv-brand') || {}).textContent || '');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
    }
    return seen;
  });
  check('▶ walks onto the rounds page', walk.indexOf('THE ROUNDS') >= 0, JSON.stringify(walk));
  check('...and the month is still there after it',
    walk.indexOf('THE MONTH AHEAD') > walk.indexOf('THE ROUNDS'), JSON.stringify(walk));

  const drawn = await page.evaluate(async () => {
    while ((document.querySelector('.tv-brand') || {}).textContent !== 'THE ROUNDS') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 400));
    return {
      cards: [].slice.call(document.querySelectorAll('.tv-col')).map((c) => ({
        who: c.querySelector('.tv-who').textContent,
        n: c.querySelector('.tv-count').textContent,
        sub: (c.querySelector('.tv-team') || {}).textContent || '',
        rooms: [].slice.call(c.querySelectorAll('.tv-job')).map((j) => j.textContent),
      })),
      tiles: [].slice.call(document.querySelectorAll('.tv-tile .cap')).map((t) => t.textContent),
      nav: [].slice.call(document.querySelectorAll('.tv-navl')).map((t) => t.textContent),
    };
  });
  const d2 = JSON.stringify(drawn);
  check('the page draws a card per round, with its floors',
    drawn.cards.some((c) => /Abdullahi/.test(c.who) && /Floors 1, 2, 10/.test(c.sub)), d2);
  check('...a morning room wears its sunrise',
    drawn.cards.some((c) => c.rooms.some((r) => /🌅 1005/.test(r))), d2);
  check('...the rooms nobody keeps lead the page in amber',
    drawn.cards[0] && /NOBODY KEEPS/.test(drawn.cards[0].who), d2);
  check('...the numbers count the arrangement, not the morning',
    drawn.tiles.join() === 'ROOMS,ROUNDS,NOBODY KEEPS', JSON.stringify(drawn.tiles));
  check('...and the remote legend names the page',
    drawn.nav.indexOf('ROUNDS') >= 0, JSON.stringify(drawn.nav));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
