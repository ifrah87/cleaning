/**
 * TWO PEOPLE ON ONE ROUND ARE ONE CARD, EVEN WHEN ONE OF THEM ALSO HAS THE BINS.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/a-pair-keeps-its-card.js
 *
 * The wall merges a pair into a single column off helperRoundOwner: somebody whose whole
 * day is helper entries on ONE person's rooms is on that person's round. "Whole day"
 * counted communal walks too — so on 13 Sep, when Mahamed Abdi Abiker was carrying
 * Barxad/Jaranjaro and Trash/Recycling on top of Abukar Daud Osman's 804, 903 and 1102,
 * the board drew them as two cards holding the same three rooms twice and the office read
 * it as the pairing having been lost.
 *
 * A round is ROOMS. The corridors do not make a man a second cleaner on floor 8 — and his
 * bins have to come onto the shared card with him, or merging the column would take real
 * work off the wall.
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
    { id: 'pLead', name: 'Abdullahi Mohamed Abdi', crew: 'Team C', isCleaner: true, isLeader: true, floors: [1], hikPersonId: 'h1' },
    // The pair. Neither is a leader, and they are carried on DIFFERENT teams — a cover
    // pair, which is when this happens. Two crews is deliberate: the shared-crew rule
    // (pairMates) cannot reach across teams, so helperRoundOwner is the only thing that
    // can draw these two as one card, and the test measures it rather than its neighbour.
    { id: 'pAbukar', name: 'Abukar Daud Osman', crew: 'Team G', isCleaner: true, hikPersonId: 'h2' },
    { id: 'pAbiker', name: 'Mahamed Abdi Abiker', crew: 'Outside team', isCleaner: true, hikPersonId: 'h3' },
  ],
  servicedUnits: [
    { id: 'u105', unit: '105', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pLead' },
    { id: 'u804', unit: '804', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbukar', assignedWith: ['pAbiker'] },
    { id: 'u903', unit: '903', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbukar', assignedWith: ['pAbiker'] },
    { id: 'u1102', unit: '1102', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbukar', assignedWith: ['pAbiker'] },
  ],
  // The two walks that split the pair: Abiker answers for both of them on his own.
  areas: [
    { id: 'trash', label: 'Trash / Recycling', kind: 'interior', freq: 'daily', assignedTo: 'pAbiker' },
    { id: 'barxad', label: 'Barxad/Jaranjaro', kind: 'interior', freq: 'daily', assignedTo: 'pAbiker' },
  ],
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
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

  console.log('\n\x1b[1mA pair keeps its card when one of them has the bins\x1b[0m');

  const read = () => page.evaluate(() => {
    const cols = tvColumns();
    return {
      names: cols.map((c) => c.name),
      pair: (cols.find((c) => /Abukar/.test(c.name)) || { jobs: [] }).jobs.map((j) => j.label),
      total: countJobs(cols).all,
    };
  });

  // THE MORNING AS THE OFFICE LEFT IT. The pins say whose rooms these are; this is the
  // board having been handed out from them, which is the state the wall is read in.
  await page.evaluate(() => {
    ['u804', 'u903', 'u1102'].forEach((id) => {
      state.servicedUnits.find((u) => u.id === id).assignedTo = 'pAbukar';
    });
  });

  const cross = await read();
  check('the two of them are one card', cross.names.some((n) => /Abukar Daud Osman \/ Mahamed Abdi Abiker/.test(n)),
    JSON.stringify(cross.names));
  check('...and Abiker has no second card of his own',
    cross.names.filter((n) => /Abiker/.test(n)).length === 1, JSON.stringify(cross.names));
  check('...carrying the round', ['804', '903', '1102'].every((u) => cross.pair.some((l) => l.indexOf(u) === 0)),
    JSON.stringify(cross.pair));
  check('...and his walks came with him, not off the wall',
    cross.pair.some((l) => /Trash/.test(l)) && cross.pair.some((l) => /Barxad/.test(l)),
    JSON.stringify(cross.pair));
  // Three shared rooms + one of the leader's + two walks. The rooms are named on both of
  // them and must still count once, or the card and the tally at the top disagree.
  check('...and nothing is counted twice', cross.total === 6, String(cross.total));
  check('...the card itself says six', (await page.evaluate(() =>
    (tvColumns().find((c) => /Abukar/.test(c.name)) || { jobs: [] }).jobs.length)) === 5, JSON.stringify(cross.pair));

  // ...AND A MAN WITH A ROOM OF HIS OWN IS STILL RUNNING A ROUND. What loosened is about
  // communal walks only; give him a room nobody else is named on and he is his own column
  // again, or this would swallow real rounds. Checked while they are still on two crews,
  // because on one crew pairMates would draw them together anyway and hide the answer.
  const ownRoom = await page.evaluate(() => {
    setUnitAssignee('u1102', 'pAbiker');
    return tvColumns().map((c) => c.name);
  });
  check('a room of his own gives him his column back',
    ownRoom.some((n) => /^Mahamed Abdi Abiker$/.test(n))
    && !ownRoom.some((n) => /Abukar Daud Osman \/ Mahamed Abdi Abiker/.test(n)),
    JSON.stringify(ownRoom));

  // THE SAME TWO MEN ON ONE CREW. The office moved them onto a team of their own to try to
  // make the wall say this, and it must read the same either way.
  const sameCrew = await page.evaluate(() => {
    setUnitAssignee('u1102', 'pAbukar');
    toggleRoomHelper('u1102', 'pAbiker');
    state.staff.forEach((p) => { if (/Abukar|Abiker/.test(p.name)) p.crew = 'Team H'; });
    const cols = tvColumns();
    return { names: cols.map((c) => c.name), total: countJobs(cols).all };
  });
  check('on one crew it still reads as one card',
    sameCrew.names.filter((n) => /Abiker/.test(n)).length === 1
    && sameCrew.names.some((n) => /Abukar Daud Osman \/ Mahamed Abdi Abiker/.test(n)),
    JSON.stringify(sameCrew.names));
  check('...and the total is unchanged', sameCrew.total === 6, String(sameCrew.total));

  // ...AND ON ONE CREW WITH A BUILDING ROTA BEHIND HIM. Somebody who works the other
  // properties on his own days is held out of the shared-crew rule for a good reason — a
  // card cannot say two places at once — and that left this pair with nothing to draw them
  // together at all. Being named on every one of another man's rooms is not a guess about
  // where he is; it is today's hand-out, and it answers on its own.
  const offsitePattern = await page.evaluate(() => {
    const p = state.staff.find((x) => /Abiker/.test(x.name));
    p.siteOn = { 4: ['2 Dhagax'] };            // Thursdays elsewhere; here the rest of the week
    const cols = tvColumns();
    return { names: cols.map((c) => c.name), total: countJobs(cols).all };
  });
  check('a man with a rota at another building is still on the round he is named on',
    offsitePattern.names.filter((n) => /Abiker/.test(n)).length === 1
    && offsitePattern.names.some((n) => /Abukar Daud Osman \/ Mahamed Abdi Abiker/.test(n)),
    JSON.stringify(offsitePattern.names));
  check('...and still nothing counted twice', offsitePattern.total === 6, String(offsitePattern.total));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
