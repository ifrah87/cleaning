/**
 * THE SEPARATE JOB IS ON THE WALL, NOT NOWHERE.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/the-flats-are-on-the-wall.js
 *
 * Airbnb is its own job — cleaned after the offices, by its own pair — so the office
 * takes it off the roll call. Off the roll call means out of todaysRoomList, which means
 * out of the columns: correct, and the reason the flats do not clutter the morning round.
 *
 * The board used to answer that with a page of its own, and then renderTV was changed to
 * `const air = []` on the grounds that "the guest flats are in the columns now". They are
 * — but only while they are ON the roll call. With Airbnb switched off, the columns do
 * not carry them and the page that would have was dead, so eleven flats appeared on the
 * television nowhere at all: no column, no page, no count. The wall did not mention them.
 *
 * Both directions are checked, because the fix is worth nothing if it draws a room twice:
 *   · OFF the roll call — the flats have their own page, and nothing in the columns.
 *   · ON the roll call  — no page at all; they are in the columns and must not be
 *     drawn a second time under a heading of their own.
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
// The daily rooms are cleaned on the Friday in advance of the Saturday, so "cleaned
// literally yesterday" is not due on a Saturday — same reasoning as the other fixtures.
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
    // Three guest flats due today: one handed to somebody, two nobody has picked up.
    { id: 'su406', unit: '406', type: 'airbnb', freq: 'daily', preferLate: true, lastCleaned: DAY_BEFORE, assignedTo: 'p1', guest: 'Faisal' },
    { id: 'su506', unit: '506', type: 'airbnb', freq: 'daily', preferLate: true, lastCleaned: DAY_BEFORE, guest: 'Warsame', time: '11:00' },
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
  // The booking feed, answered locally like everything else. 406 and 606 are booked;
  // 506 carries a stale guest name in this app and no booking at all.
  const soon = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return key(d); };
  const ago = (n) => soon(-n);
  await ctx.route('**://app.orfanerealestate.so/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ ok: true, asOf: WORK_TODAY, data: [
      { unit: '406', guest: 'Mohamed Ahmed Yusuf', from: ago(9), until: soon(5) },
      { unit: '606', guest: 'Bahjo', from: ago(6), until: soon(1) },
      // ...and one who has not arrived yet. The feed carries the week ahead so the
      // board can see it coming; a room nobody is in must not be drawn as occupied.
      { unit: '806', guest: 'Not Arrived Yet', from: soon(3), until: soon(10) },
    ] }),
  }));
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html?tv=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tv-col', { timeout: 20000 });
  await page.waitForTimeout(3000);

  console.log('\n\x1b[1mThe flats are on the wall\x1b[0m');

  // The premise: off the roll call, so the columns cannot be carrying them.
  const inColumns = await page.evaluate(() =>
    tvColumns().reduce((a, c) => a.concat(c.jobs.map((j) => j.label)), []));
  check('a flat nobody holds is not in the columns, Airbnb being off the roll call',
    !inColumns.some((l) => /^(506|606)/.test(l)), inColumns.join(', '));
  // ...but one that HAS been given rides in on today's plan, and belongs to its cleaner.
  check('...while the one somebody was given is in their column',
    inColumns.some((l) => /^406/.test(l)), inColumns.join(', '));

  const held = await page.evaluate(() => tvOffRollCall().map((u) => u.unit));
  check('...and all three are owed today, by the board\u2019s own reckoning',
    held.join(',') === '406,506,606', JSON.stringify(held));

  // The board does not turn itself: the other pages are reached with the remote, which
  // is what ArrowRight is here. Walk right until the flats page comes up, or run out.
  let air = null;
  for (let i = 0; i < 6 && !air; i += 1) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    air = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.tv-aircard')];
      if (!cards.length) return null;
      return {
        title: (document.querySelector('.tv-brand') || {}).textContent || '',
        units: cards.map((c) => (c.querySelector('.tv-airunit') || {}).textContent),
      };
    });
  }

  check('the separate job has a page on the wall, reachable on the remote', !!air,
    air ? '' : 'no .tv-aircard on any page');
  check('...carrying the flats the columns did not take',
    !!air && air.units.join(',') === '506,606', JSON.stringify(air && air.units));
  // The whole reason this page was emptied in the first place. A room on a card AND on
  // a page of its own is two jobs on the wall and one in the building.
  check('...and not repeating the one already on a cleaner’s card',
    !!air && !air.units.some((u) => /^406/.test(u)), JSON.stringify(air && air.units));
  check('...under a heading that names what is on it',
    !!air && /AIRBNB/.test(air.title), air && air.title);

  // THE OTHER DIRECTION. Put Airbnb back on the roll call and the flats ride in the
  // columns — so a page of their own would be the same rooms twice, and must not appear.
  const both = await page.evaluate(() => {
    state.rollCallTypes = null;             // every kind on the roll call
    const cols = tvColumns().reduce((a, c) => a.concat(c.jobs.map((j) => j.label)), []);
    return { cols, air: tvOffRollCall().map((u) => u.unit) };
  });
  check('back on the roll call, the flats are in the columns',
    both.cols.some((l) => /^406/.test(l)), both.cols.join(', '));
  check('...and get no second page, so no room is drawn twice',
    both.air.length === 0, JSON.stringify(both.air));

  // ---- WHO IS IN --------------------------------------------------------------
  // Occupancy and until-when, read from the booking feed. The fixture answers it below
  // with two rooms staying and one that is not booked at all.
  await page.evaluate(() => { state.rollCallTypes = ['office', 'building']; tvPage = 0; renderTV(); });
  await page.waitForTimeout(400);

  const strip = await page.evaluate(() => {
    const bar = document.querySelector('.tv-guestbar');
    if (!bar) return null;
    return {
      n: (bar.querySelector('.tv-guestn') || {}).textContent,
      in: [...bar.querySelectorAll('.tv-guestchip.in')].map((c) => c.textContent),
    };
  });
  check('the board itself carries a guests strip, for walking past',
    !!strip, 'no .tv-guestbar on the board');
  check('...counting the rooms the BOOKINGS say are in use, not the names typed here',
    !!strip && strip.n.replace(/\s/g, '') === '2/3', JSON.stringify(strip));
  check('...and marking which rooms those are',
    !!strip && strip.in.join(',') === '406,606', JSON.stringify(strip && strip.in));

  // The page is reached by CLICKING its name, which is the half a remote cannot do and
  // every phone this URL opens on needs.
  const clicked = await page.evaluate(() => {
    const lbl = [...document.querySelectorAll('.tv-navl')].find((n) => /WHO/.test(n.textContent));
    if (!lbl) return null;
    lbl.click();
    return {
      title: (document.querySelector('.tv-brand') || {}).textContent,
      units: [...document.querySelectorAll('.tv-stayunit')].map((n) => n.textContent),
      names: [...document.querySelectorAll('.tv-stayname')].map((n) => n.textContent),
      dates: [...document.querySelectorAll('.tv-staydates')].map((n) => n.textContent),
      left: [...document.querySelectorAll('.tv-stayleft')].map((n) => n.textContent),
      // innerText of the board itself: textContent on <body> drags in the inline
      // <script>, whose own regexes contain a $ and which nobody can read off a wall.
      text: ((document.getElementById('app') || {}).innerText || ''),
      bar: !!document.querySelector('.tv-bar'),
    };
  });
  check('the page is named in the legend and opens on a click', !!clicked && /WHO IS IN/.test(clicked.title),
    clicked ? clicked.title : 'no WHO label in the legend');
  // Soonest out first — the room that has to be turned around next leads the page.
  check('...a card per room somebody is in, the soonest to leave first',
    !!clicked && clicked.units.join(',') === 'UNIT 606,UNIT 406', JSON.stringify(clicked && clicked.units));
  // A television on an office wall is read by everybody who walks past it, guests
  // included. The room and the dates answer the question; the name is not ours to post.
  check('...and NOT the guest\u2019s name, which is theirs', !!clicked && clicked.names.length === 0,
    JSON.stringify(clicked && clicked.names));
  check('...no guest name anywhere on the page at all',
    !!clicked && !/Bahjo|Mohamed Ahmed Yusuf|Not Arrived/i.test(clicked.text),
    JSON.stringify(clicked && (clicked.text.match(/.{0,20}(Bahjo|Yusuf).{0,20}/i) || [])[0]));
  check('...and the dates they hold the room for',
    !!clicked && clicked.dates.every((d) => /→/.test(d)), JSON.stringify(clicked && clicked.dates));
  check('...and how many nights that is, and how much is left',
    !!clicked && /nights/.test(clicked.left.join(' ')) && /day/.test(clicked.left.join(' ')),
    JSON.stringify(clicked && clicked.left));
  // The guest arriving in three days is on the feed and must not be drawn as though
  // somebody were already in the room.
  check('...and a booking that has not started is not on it',
    !!clicked && !clicked.units.some((u) => /806/.test(u)), JSON.stringify(clicked && clicked.units));
  // A flat with a name typed in this app but NO booking is not a stay either.
  check('...nor a room with a stale name here and no booking',
    !!clicked && !clicked.units.some((u) => /506/.test(u)), JSON.stringify(clicked && clicked.units));

  // NO MENTION OF MONEY. The office card this is modelled on carries a nightly rate, a
  // balance, an unpaid badge and a deposit; none of it belongs on a wall.
  const moneyish = !!clicked && (/[$£€]/.test(clicked.text)
    || /\b(unpaid|paid|deposit|rate|night(ly)? rate|balance|owing|invoice)\b/i.test(clicked.text));
  check('...and not one word about money anywhere on the wall', !!clicked && !moneyish,
    JSON.stringify(clicked && (clicked.text.match(/.{0,24}([$£€]|unpaid|deposit|balance).{0,24}/i) || [])[0]));
  check('...and no progress bar claiming work that was never counted',
    !!clicked && !clicked.bar, 'the done-bar is on the guests page');

  // A FEED THAT DID NOT ANSWER IS NOT AN EMPTY BUILDING. The difference has to be on
  // the screen, or the wall quietly reports nobody is staying.
  const blind = await page.evaluate(() => {
    tvStays = null; renderTV();
    return (document.getElementById('app') || {}).innerText || '';
  });
  check('a feed that could not be read says so, rather than showing an empty building',
    /could not be read/i.test(blind), blind.slice(0, 120));

  // The bug the page list exists to stop: a page that exists but cannot be reached.
  const reach = await page.evaluate(() => {
    const seen = [];
    const n = tvPageList().length;
    for (let i = 0; i < n; i += 1) {
      tvPage = i; renderTV();
      seen.push((document.querySelector('.tv-brand') || {}).textContent);
    }
    return { n, seen };
  });
  check('every page the remote can reach is a page that draws something',
    reach.seen.length === reach.n && reach.seen.every(Boolean), JSON.stringify(reach));
  check('...and the month is still one of them',
    reach.seen.some((t) => /MONTH/.test(t)), JSON.stringify(reach.seen));

  check('no page errors', errs.length === 0, errs.join('\n'));

  const passed = out.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${out.length} passed\n`);
  await browser.close();
  s.close();
  process.exit(out.length - passed ? 1 : 0);
})();
