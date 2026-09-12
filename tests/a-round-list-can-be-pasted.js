/**
 * RE-CUTTING THE ROUNDS IS A LIST, SO LET IT BE A LIST.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/a-round-list-can-be-pasted.js
 *
 * Changing who keeps which room is one room card at a time. Twenty-three rooms is well
 * over a hundred taps, done standing up at eight in the morning off a sheet somebody
 * wrote out — and every tap is a chance to put 704 on the wrong name, with nothing
 * afterwards to say you did.
 *
 * So the sheet is the input. It sets the PIN, not today's board: the pin is where a room
 * goes back to every week and what the days ahead are laid out from. Names in this
 * building are spelled more than one way — Mahamed and Mohamed, Abiker and Amin — so the
 * match has to be forgiving, without ever guessing between two people.
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
    { id: 'pAbdullahi', name: 'Abdullahi Mohamed Abdi', crew: 'Team C', isCleaner: true, isLeader: true, floors: [8, 9], hikPersonId: 'h1' },
    { id: 'pAbukar', name: 'Abukar Daud Osman', crew: 'Team H', isCleaner: true, hikPersonId: 'h2' },
    { id: 'pAbiker', name: 'Mahamed Abdi Abiker', crew: 'Team H', isCleaner: true, hikPersonId: 'h3' },
    // Two men who share most of a name: the match must refuse rather than pick one.
    { id: 'pMahadA', name: 'Mahad Abdi Mohamed', crew: 'Team G', isCleaner: true, isLeader: true, floors: [5], hikPersonId: 'h4' },
    { id: 'pMahadH', name: 'Mahad Hussein Hassan', crew: 'Team B', isCleaner: true, isLeader: true, floors: [3], hikPersonId: 'h5' },
  ],
  servicedUnits: [
    { id: 'u105', unit: '105', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pMahadH' },
    { id: 'u201', unit: '201', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pMahadH' },
    { id: 'u803', unit: '803', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbdullahi' },
    { id: 'u804', unit: '804', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbdullahi' },
    { id: 'u503', unit: '503', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pMahadA' },
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

  console.log('\n\x1b[1mA round list can be pasted\x1b[0m');

  const read = await page.evaluate(() => {
    const p = parseRoundList(
      'Abdullahi Mohamed Abdi: 105, 201\n'
      + 'Abukar Daud Osman + Mahamed Abdi Abiker: 803 804\n');
    return {
      rounds: p.rounds.map((r) => ({ people: r.people.map((x) => x.id), rooms: r.rooms.map((u) => u.unit) })),
      problems: p.problems,
      moves: roundListChanges(p).map((m) => m.unit + ' ' + m.from + '→' + m.to),
    };
  });
  check('a plain line reads as a round',
    JSON.stringify(read.rounds[0]) === '{"people":["pAbdullahi"],"rooms":["105","201"]}', JSON.stringify(read));
  check('...and a + makes one round of two, the first answering for it',
    JSON.stringify(read.rounds[1]) === '{"people":["pAbukar","pAbiker"],"rooms":["803","804"]}', JSON.stringify(read));
  check('...with commas or spaces between the rooms, either way',
    read.rounds[1].rooms.length === 2, JSON.stringify(read));
  check('...and it says what would change before anything does',
    read.moves.length === 4 && read.problems.length === 0, JSON.stringify(read));

  // A NAME SPELLED THE OTHER WAY IS THE SAME MAN; A NAME THAT COULD BE TWO IS NOBODY.
  const names = await page.evaluate(() => ({
    variant: (matchStaffByName('Mohamed Abdi Abiker').person || {}).id || null,
    partial: (matchStaffByName('Abdullahi Abdi').person || {}).id || null,
    ambiguous: matchStaffByName('Mahad').error || null,
    unknown: matchStaffByName('Jane Doe').error || null,
  }));
  check('a name spelled the other way still finds the man', names.variant === 'pAbiker', JSON.stringify(names));
  check('...and two name-parts are enough to place him', names.partial === 'pAbdullahi', JSON.stringify(names));
  check('...but a name that could be two people is refused, never guessed',
    !!names.ambiguous, JSON.stringify(names));
  check('...and a name nobody has is said so', !!names.unknown, JSON.stringify(names));

  const bad = await page.evaluate(() => {
    const a = parseRoundList('Abdullahi Mohamed Abdi: 105, 999');
    const b = parseRoundList('Abdullahi Mohamed Abdi: 105\nMahad Abdi Mohamed: 105');
    return { room: a.problems.join('|'), twice: b.problems.join('|') };
  });
  check('a room number nobody has is reported', /999/.test(bad.room), JSON.stringify(bad));
  check('...and so is the same room on two rounds', /two rounds/.test(bad.twice), JSON.stringify(bad));

  const applied = await page.evaluate(() => {
    const p = parseRoundList(
      'Abdullahi Mohamed Abdi: 105, 201\n'
      + 'Abukar Daud Osman + Mahamed Abdi Abiker: 803 804\n');
    applyRoundList(p);
    const u = (n) => state.servicedUnits.find((x) => x.unit === n);
    return {
      u105: u('105').usualTo, u201: u('201').usualTo,
      u803: u('803').usualTo, with803: u('803').assignedWith,
      with105: u('105').assignedWith,
      stamped: !!u('105').editedAt,
      untouched: u('503').usualTo,
    };
  });
  check('applying it moves the pins', applied.u105 === 'pAbdullahi' && applied.u201 === 'pAbdullahi', JSON.stringify(applied));
  check('...names the second man alongside on a shared round',
    applied.u803 === 'pAbukar' && JSON.stringify(applied.with803) === '["pAbiker"]', JSON.stringify(applied));
  check('...leaves a solo round with nobody alongside', applied.with105 === null, JSON.stringify(applied));
  check('...stamps what it touched, so a merge cannot undo it', applied.stamped, JSON.stringify(applied));
  check('...and leaves rooms the list never mentioned alone',
    applied.untouched === 'pMahadA', JSON.stringify(applied));

  // Run it again and there is nothing left to do — the preview has to say so rather than
  // offering to move rooms that are already where they belong.
  const again = await page.evaluate(() => roundListChanges(parseRoundList(
    'Abdullahi Mohamed Abdi: 105, 201\nAbukar Daud Osman + Mahamed Abdi Abiker: 803 804')).length);
  check('pasting the same list twice changes nothing the second time', again === 0, 'moves = ' + again);

  const ui = await page.evaluate(() => {
    setTab('team');
    return [].slice.call(document.querySelectorAll('button')).some((b) => /Paste a round list/.test(b.textContent));
  });
  check('there is somewhere on the Team page to paste it', ui, 'no panel found');

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
