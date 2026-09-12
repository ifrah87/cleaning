/**
 * A ROOM SOMEBODY WHO IS HERE IS NAMED ON IS NOT STILL FALLING ON THE FLOOR.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/covered-rooms-leave-the-sick-card.js
 *
 * 12 Sep. Sadaaq Ali Abdi was marked sick and his 401, 403 and 404 were picked up by
 * Abukar Daud Osman and Mahamed Abdi Abiker, who were drawn correctly as one pair card.
 * The three rooms stayed on Sadaaq's card too: heldBy only asks whether the owner is on
 * today's rota, and somebody who rings in sick after badging in still is, so being
 * covered never took the room out of his bucket.
 *
 * The wall therefore showed each of those rooms twice, Sadaaq's card read 0/9 for a
 * round he was not on — he was covering Hassan's 1002 on the other side of the board —
 * and all three counted towards NEED COVER, which read eleven when it was eight. JOBS
 * TODAY said 33 against 36 across the cards, because countJobs dedupes and the columns
 * did not.
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
// Two days back, not one: a room cleaned on the Friday is not due again on the
// Saturday (doneFridayForSaturday), and this test must be about cover, not the calendar.
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 3 : 2)); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const APP_STATE = {
  staff: [
    // Sick, and badged in before it was known — which is why the rota still has him on.
    { id: 'pSad', name: 'Sadaaq Ali Abdi', crew: 'Team D', isCleaner: true, isLeader: true, floors: [4], hikPersonId: 'h1' },
    // The pair who actually went to his rooms, drawn from two different teams.
    { id: 'pAbu', name: 'Abukar Daud Osman', crew: 'Team H', isCleaner: true, floors: [8], hikPersonId: 'h2' },
    { id: 'pAbi', name: 'Mahamed Abdi Abiker', crew: 'Team H', isCleaner: true, hikPersonId: 'h3' },
    // On the sick man's team, holding nothing of his own: named under his leader while
    // that leader is in, and standing on a card of his own once he is not.
    { id: 'pAdan', name: 'Adan Abdullahi Nur', crew: 'Team D', isCleaner: true, hikPersonId: 'h4' },
  ],
  servicedUnits: [
    // Covered: named on Sadaaq, walked by the pair.
    { id: 'su401', unit: '401', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'pSad', assignedWith: ['pAbu', 'pAbi'] },
    { id: 'su403', unit: '403', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'pSad', assignedWith: ['pAbu', 'pAbi'] },
    { id: 'su404', unit: '404', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'pSad', assignedWith: ['pAbu', 'pAbi'] },
    // NOT covered: nobody else is named on it, so it is genuinely on the floor.
    { id: 'su105', unit: '105', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'pSad' },
    // The pair's own room, which must not be disturbed by any of this.
    { id: 'su802', unit: '802', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'pAbu' },
  ],
  areas: [], completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  attendance: { pSad: 'sick' },
  // As the building actually runs it: nothing deals itself out, so a sick man's room
  // stays on him until somebody picks it up by hand. That is what makes 105 a real
  // uncovered room rather than one the morning quietly re-dealt to the pair.
  autoAssign: false, autoBalance: false, autoConfirm: true,
  rollCallTypes: ['office', 'building'],
};
const EVENTS = [
  { person_name: 'Sadaaq Ali Abdi', person_code: '1', event_time: WORK_TODAY + ' 06:34:00' },
  { person_name: 'Abukar Daud Osman', person_code: '2', event_time: WORK_TODAY + ' 05:51:00' },
  { person_name: 'Mahamed Abdi Abiker', person_code: '3', event_time: WORK_TODAY + ' 05:51:00' },
  { person_name: 'Adan Abdullahi Nur', person_code: '4', event_time: WORK_TODAY + ' 06:46:00' },
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

  console.log('\n\x1b[1mA covered room leaves the sick man’s card\x1b[0m');

  // The board state as the wall actually held it at 08:15: the rooms still NAMED on
  // Sadaaq, with the pair named alongside. Set here rather than left to the app's own
  // sick hand-on, which re-deals a sick man's round and so cannot produce the thing
  // being tested — the morning this happened, it plainly had not run.
  await page.evaluate(() => {
    const u = (id) => state.servicedUnits.find((x) => x.id === id);
    ['su401', 'su403', 'su404'].forEach((id) => { u(id).assignedTo = 'pSad'; u(id).assignedWith = ['pAbu', 'pAbi']; });
    u('su105').assignedTo = 'pSad'; delete u('su105').assignedWith;
    u('su802').assignedTo = 'pAbu'; delete u('su802').assignedWith;
    render();
  });

  const cols = await page.evaluate(() => tvColumns().map((c) => ({
    name: c.name, out: !!c.out, none: !!c.none, jobs: c.jobs.map((j) => j.label),
  })));
  const dump = JSON.stringify(cols);
  const sad = cols.find((c) => /Sadaaq/.test(c.name));
  const pair = cols.find((c) => /Abukar/.test(c.name) && /Abiker/.test(c.name));

  check('the pair who took the rooms share one card', !!pair, dump);
  check('...and the three covered rooms are on it',
    !!pair && ['401', '403', '404'].every((u) => pair.jobs.some((l) => l.startsWith(u))), dump);

  check('the sick man still has a card', !!sad && sad.out, dump);
  check('...without the rooms somebody who is in is walking',
    !!sad && !sad.jobs.some((l) => /^(401|403|404)/.test(l)), dump);
  check('...and still holding the one nobody took',
    !!sad && sad.jobs.some((l) => l.startsWith('105')), dump);

  // Every room is drawn exactly once across the whole board.
  const seen = {};
  cols.forEach((c) => c.jobs.forEach((l) => { const u = l.split(' ')[0]; seen[u] = (seen[u] || 0) + 1; }));
  check('no room is drawn twice anywhere on the board',
    Object.values(seen).every((n) => n === 1), JSON.stringify(seen));

  // The number that means somebody has to act counts 105 and nothing else.
  const cover = await page.evaluate(() => tvColumns().filter((c) => c.out || c.none)
    .reduce((n, c) => n + c.jobs.filter((j) => !j.done && !j.air).length, 0));
  check('NEED COVER counts only the room nobody is on', cover === 1, 'cover = ' + cover);

  // The tally has always been right. The cards must now agree with it.
  const all = await page.evaluate(() => countJobs(tvColumns()).all);
  const drawn = cols.reduce((n, c) => n + c.jobs.length, 0);
  check('JOBS TODAY agrees with what is drawn on the cards',
    all === drawn && all === 5, 'total ' + all + ' vs ' + drawn + ' drawn');

  // ONE PERSON, ONE PLACE ON THE BOARD. Adan holds nothing of his own, so he stands on
  // a card of his own the moment his leader is off — and must not also be printed under
  // that leader, which is the same man on the wall twice.
  const withCols = await page.evaluate(() => tvColumns().map((c) => ({ name: c.name, with: c.with || '' })));
  check('the man with no rooms of his own gets a card while his leader is off',
    withCols.some((c) => /Adan/.test(c.name)), JSON.stringify(withCols));
  check('...and the sick leader’s card no longer names him as well',
    !withCols.some((c) => /Adan/.test(c.with)), JSON.stringify(withCols));

  // ...and the rule still works the other way: a leader who IS in keeps his name.
  const backIn = await page.evaluate(() => {
    state.attendance.pSad = 'present'; render();
    return tvColumns().map((c) => ({ name: c.name, with: c.with || '' }));
  });
  check('a leader who is in still has his man named under him',
    backIn.some((c) => /Sadaaq/.test(c.name) && /Adan/.test(c.with))
      && !backIn.some((c) => /^Adan/.test(c.name)), JSON.stringify(backIn));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
