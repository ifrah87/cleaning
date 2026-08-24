/**
 * THE PHONE IS LAID OUT LIKE THE WALL.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/roll-mirrors-board.js
 *
 * The roll call and the TV showed the same work in two different shapes — a column per
 * cleaner on the wall, one flat run of chips on the phone — so the office could not read
 * one against the other. Both come off tvColumns() now. This checks they cannot drift
 * apart again, and that a communal area can name more than one person.
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
  staff: [
    { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [1, 2], hikPersonId: 'h1' },
    { id: 'p2', name: 'Hodan Omar', crew: 'Team B', isCleaner: true, isLeader: true, floors: [3], hikPersonId: 'h2' },
  ],
  servicedUnits: [
    { id: 'su101', unit: '101', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
    { id: 'su102', unit: '102', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1' },
    { id: 'su301', unit: '301', type: 'building', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p2' },
  ],
  areas: [{ id: 'corridors', label: 'Corridors', kind: 'interior', freq: 'daily', assignedTo: 'p1' }],
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
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
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
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

  console.log('\n\x1b[1mThe roll call is laid out like the board\x1b[0m');

  // What the wall would show, from the same call the roll call now renders.
  const cols = await page.evaluate(() => tvColumns().map((c) => ({
    name: c.none ? 'NOBODY YET' : c.name,
    jobs: c.jobs.map((j) => j.label),
  })));
  const bodyText = await page.locator('.body').first().textContent();

  // ONE SCREEN, ONE JOB. The roll call decides the morning and says how much is left;
  // the ticking screen is where the board is mirrored and the work recorded.
  // There is no tab bar and no separate ticking screen: the board is what the app opens
  // on, and it is the same board that is on the wall.
  check('the app opens on the board itself',
    await page.evaluate(() => state.tab === 'board') && (await page.locator('.bd-col').count()) > 0,
    'tab: ' + await page.evaluate(() => state.tab));

  await page.evaluate(() => setTab('board'));
  await page.waitForTimeout(700);
  const tickBody = await page.locator('.body').first().textContent();
  // The ticking screen sets names in caps — it is read at arm's length, walking.
  const tickFlat = tickBody.toUpperCase();
  check('every column on the board has a block on the phone',
    cols.every((c) => tickFlat.includes(c.name.toUpperCase())), cols.map((c) => c.name).join(' | '));
  check('and every job under it is named there too',
    cols.every((c) => c.jobs.every((j) => tickBody.includes(j))), JSON.stringify(cols));
  check('the communal area sits in its cleaner’s block, not a list of its own',
    tickBody.includes('Corridors'), 'areas: ' + JSON.stringify(cols.map((c) => c.jobs)));
  // "Has she even arrived yet?" is asked at the same moment as "is 204 done?", so the
  // badge time is on the screen where the round is worked, not only on the wall.
  check('each cleaner’s badge-in time is on the board',
    /IN \d{1,2}:\d{2}/i.test(tickBody), tickBody.slice(0, 160));

  const chip = page.locator('button', { hasText: /^101/ }).first();
  await chip.click();
  await page.waitForTimeout(700);
  const ticked = await page.evaluate(() => {
    const u = state.servicedUnits.find((x) => x.unit === '101');
    return { done: cleanedToday(u), label: (tvColumns().flatMap((c) => c.jobs).find((j) => j.label === '101') || {}).done };
  });
  check('tapping a room in a block marks it cleaned', ticked.done === true, JSON.stringify(ticked));
  check('and the board says the same about it', ticked.label === true, JSON.stringify(ticked));

  // More than one person on a communal area.
  const shared = await page.evaluate(() => {
    // The picker is folded away until asked for — open it the way a thumb would.
    _areaWithOpen = 'corridors';
    toggleAreaHelper('corridors', 'p2');
    const job = tvColumns().flatMap((c) => c.jobs).find((j) => String(j.label).startsWith('Corridors'));
    const a = state.areas.find((x) => x.id === 'corridors');
    const cols2 = tvColumns();
    return {
      label: job && job.label, answerable: a.assignedTo, alsoOn: a.assignedWith,
      // On both boards...
      columnsShowingIt: cols2.filter((c) => c.jobs.some((j) => j.area && j.id === 'corridors')).length,
      // ...and still one job when the morning is counted.
      counted: countJobs(cols2).all,
      rows: cols2.flatMap((c) => c.jobs).length,
    };
  });
  check('a second person can be put on a communal area', (shared.alsoOn || []).includes('p2'), JSON.stringify(shared));
  check('and the board names them on it', /Corridors \+ Hodan/.test(shared.label || ''), String(shared.label));
  check('a shared area is on both their boards', shared.columnsShowingIt === 2, JSON.stringify(shared));
  check('but it is counted once — a job on two boards is not two jobs',
    shared.counted === 4 && shared.rows === 5, JSON.stringify(shared));
  check('and one of them still answers for it', shared.answerable === 'p1', JSON.stringify(shared));

  // A communal space is the building's, not one person's: whoever is in is on it.
  const everyone = await page.evaluate(() => {
    setAreaEveryone('corridors');
    const a = state.areas.find((x) => x.id === 'corridors');
    const cols = tvColumns();
    return {
      onIt: [a.assignedTo].concat(a.assignedWith || []).sort(),
      columns: cols.filter((c) => c.jobs.some((j) => j.area && j.id === 'corridors')).length,
      counted: countJobs(cols).all,
    };
  });
  check('"Everyone in" puts the whole crew on a communal space',
    JSON.stringify(everyone.onIt) === JSON.stringify(['p1', 'p2']), JSON.stringify(everyone));
  check('and it is on every one of their boards', everyone.columns === 2, JSON.stringify(everyone));
  check('still counted once, however many are on it', everyone.counted === 4, JSON.stringify(everyone));

  await page.waitForTimeout(400);
  const after = await page.locator('.body').first().textContent();
  check('the phone names them too', /Corridors \+ Hodan/.test(after), 'not found on the ticking screen');
  // --- the ticking screen, again ------------------------------------------------
  const tickText = await page.locator('.body').first().textContent();
  const jobs = await page.evaluate(() => tvColumns().flatMap((c) => c.jobs).map((j) => j.label));
  check('the Tick off tab lists every job on the board',
    jobs.every((j) => tickText.includes(j)), jobs.join(' | '));
  check('and nothing else — no attendance, no set-up',
    !tickText.includes('Sync Staff') && !tickText.includes('badged in'), tickText.slice(0, 120));
  const wasDone = await page.evaluate(() => cleanedToday(state.servicedUnits.find((x) => x.unit === '102')));
  await page.locator('button', { hasText: /^102$/ }).first().click();
  await page.waitForTimeout(700);
  const nowDone = await page.evaluate(() => ({
    done: cleanedToday(state.servicedUnits.find((x) => x.unit === '102')),
    board: (tvColumns().flatMap((c) => c.jobs).find((j) => j.label === '102') || {}).done,
  }));
  check('tapping a row there ticks the job', wasDone === false && nowDone.done === true, JSON.stringify({ wasDone, nowDone }));
  check('and the wall agrees immediately', nowDone.board === true, JSON.stringify(nowDone));

  // --- assistants and guest flats ------------------------------------------------
  const shape = await page.evaluate(() => {
    // Hodan becomes Amina's assistant, holding nothing: one round, not two.
    const h = state.staff.find((p) => p.id === 'p2');
    h.isLeader = false; h.crew = 'Team A';
    state.servicedUnits.forEach((u) => { if (u.assignedTo === 'p2') u.assignedTo = 'p1'; });
    // A guest flat with somebody's name on the room record.
    state.servicedUnits.push({ id: 'suA1', unit: 'A1', type: 'airbnb', freq: 'daily', assignedTo: 'p1', preferLate: true });
    save(); render();
    const cols = tvColumns();
    const air = cols.find((c) => c.jobs.some((j) => j.air));
    return {
      hasOwnColumn: cols.some((c) => c.name && c.name.indexOf('Hodan') === 0),
      namedWithLeader: (cols.find((c) => (c.name || '').indexOf('Amina') === 0) || {}).with || '',
      airIsDealt: !!(air && !air.none),
      // Afternoon work sits below the morning round. Finished jobs sort below both —
      // they are done — so the question is where it falls among what is still open.
      airIsLast: (() => {
        const c = cols.find((x) => x.jobs.some((j) => j.air));
        if (!c) return false;
        const open = c.jobs.filter((j) => !j.done);
        return open.length > 1 && open[open.length - 1].air === true;
      })(),
    };
  });
  check('an assistant holding nothing gets no column of their own', shape.hasOwnColumn === false, JSON.stringify(shape));
  check('they are named on their leader instead', /Hodan/.test(shape.namedWithLeader), shape.namedWithLeader);
  await page.waitForTimeout(400);
  const rollText = await page.locator('.body').first().textContent();
  check('a guest flat is dealt to a cleaner like any other room', shape.airIsDealt === true, JSON.stringify(shape));
  check('and sits at the foot of the column, after the morning round', shape.airIsLast === true, JSON.stringify(shape));

  // --- a button per kind of work, and the group's frequency behind it -------------
  await page.evaluate(() => setTab('board'));
  await page.waitForTimeout(600);
  const segs = await page.locator('.bd-tab').allTextContents();
  check('there is a button for each kind of work',
    segs.includes('All') && segs.some((x) => /Airbnb/i.test(x)) && segs.some((x) => /Communal/i.test(x)),
    segs.slice(0, 8).join(' | '));

  await page.locator('.bd-tab', { hasText: /Airbnb/i }).first().click();
  await page.waitForTimeout(700);
  const airOnly = await page.evaluate(() => {
    const shown = tvColumns().flatMap((c) => c.jobs);
    return { filter: state.tickFilter, air: shown.filter((j) => j.air).length };
  });
  check('tapping it holds one kind of work at a time', airOnly.filter === 'airbnb', JSON.stringify(airOnly));
  const airBody = await page.locator('.body').first().textContent();
  check('and offers that group’s frequency from the same screen',
    /how often/i.test(airBody) && /Every other day/.test(airBody), airBody.slice(0, 180));
  check('a morning room is not in the list while Airbnb is showing',
    !/\b101\b/.test(airBody), airBody.slice(0, 200));

  // --- handing a leader more work, from the board ---------------------------------
  await page.locator('.bd-tab', { hasText: /^All$/ }).first().click();
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    // Something spare to give: a room nobody holds.
    state.servicedUnits.push({ id: 'suSpare', unit: '909', type: 'building', freq: 'daily', assignedTo: null });
    save(); render();
  });
  await page.waitForTimeout(500);
  await page.locator('button.bd-more', { hasText: /Give .* more work/ }).first().click();
  await page.waitForTimeout(600);
  const offered = await page.locator('.body').first().textContent();
  check('the board offers what is still spare', /909/.test(offered), 'no spare list');
  // Scoped to the "give them more work" list: 909 is also sitting in NOBODY YET, where
  // a tap would tick it clean rather than hand it to anybody.
  // On the board the spare jobs are chips, not rows: "＋ 909".
  await page.locator('.givelist button', { hasText: /909/ }).first().click();
  await page.waitForTimeout(700);
  const given = await page.evaluate(() => {
    const u = state.servicedUnits.find((x) => x.unit === '909');
    return { to: u.assignedTo, onBoard: tvColumns().some((c) => c.key === u.assignedTo && c.jobs.some((j) => j.label === '909')) };
  });
  check('tapping one hands it to that leader', !!given.to, JSON.stringify(given));
  check('and it lands in their column', given.onBoard === true, JSON.stringify(given));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
