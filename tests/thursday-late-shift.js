/**
 * RANDOM PEOPLE STAY LATE ON A THURSDAY, AND IT CHANGES EVERY WEEK.
 *
 * Ifrah, 2026-11-03/04: every Thursday some of the crew work 10:00–20:00, picked at random,
 * different people week to week. Everybody else works Thursday as normal, and which rooms
 * are left for later is the cleaners' call, so the late shift names people and moves nothing.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/thursday-late-shift.js
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const SUPA_HOST = 'issnrivggzkhrcjfhzit.supabase.co';

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1e3) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

// Six teams that run a round (a leader each), one with an assistant, and an outside pair
// with no leader — which must never be put on the office's late shift.
const TEAMS = ['Team A', 'Team B', 'Team C', 'Team D', 'Team E', 'Team F'];
const APP_STATE = {
  staff: TEAMS.map((t, i) => ({ id: 'L' + i, name: 'Leader' + i + ' Surname', crew: t, isCleaner: true, isLeader: true, floors: [] }))
    .concat([
      { id: 'A0', name: 'Helper Zero', crew: 'Team A', isCleaner: true, isAssistant: true, floors: [] },
      { id: 'O1', name: 'Outside One', crew: 'Outside team', isCleaner: true, floors: [] },
      { id: 'O2', name: 'Outside Two', crew: 'Outside team', isCleaner: true, floors: [] },
      { id: 'H0', name: 'Helper One', crew: 'Team B', isCleaner: true, isAssistant: true, floors: [] },
      { id: 'H1', name: 'Helper Two', crew: 'Team C', isCleaner: true, isAssistant: true, floors: [] },
      { id: 'H2', name: 'Helper Three', crew: 'Team D', isCleaner: true, isAssistant: true, floors: [] },
      { id: 'BOSS', name: 'Boss Person', crew: 'Lead', isCleaner: true, isLeader: true, floors: [] },
    ]),
  teams: TEAMS.map((t) => ({ name: t, color: '#0284c7', floors: [] })).concat([{ name: 'Outside team', color: '#15803d', floors: [] }]),
  servicedUnits: [],
  floors: 11, completions: {}, assignConfirmed: {}, manualArrivals: {}, attendance: {}, plans: {},
};

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
    if (url.includes('/rest/v1/cleaning_log')) return json([], m === 'POST' ? 201 : 200);
    return json([]);
  });
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.header', { timeout: 20000 });
  await page.waitForTimeout(3000);

  const q = await page.evaluate(() => {
    const out = {};
    out.offBefore = !lateShiftOn() && lateShiftFor(comingThursday(workToday())) === null;

    setLateShift(true);
    const from = state.lateShift.from;
    const gap = Math.round((new Date(from + 'T00:00:00') - new Date(workToday() + 'T00:00:00')) / 864e5);
    out.from = { dow: dowOf(from), gap, hours: lateShiftHours() };

    // Twelve Thursdays in a row, drawn the way the app draws them: one after another.
    const days = [];
    for (let i = 0; i < 12; i += 1) days.push(shiftDay(from, 7 * i));
    state.lateShiftDraws = {};
    days.forEach((d) => { state.lateShiftDraws[d] = drawLateShift(d); });
    const draws = days.map((d) => state.lateShiftDraws[d].people);
    const count = {};
    draws.forEach((ts) => ts.forEach((t) => { count[t] = (count[t] || 0) + 1; }));
    out.sizes = draws.map((ts) => ts.length);
    out.count = count;
    out.backToBack = draws.slice(1).some((ts, i) => ts.some((t) => draws[i].indexOf(t) >= 0));
    out.outsideEver = draws.some((ts) => ts.some((id) => id === 'O1' || id === 'O2'));
    out.bossEver = draws.some((ts) => ts.indexOf('BOSS') >= 0);
    out.poolSize = lateShiftPool().length;

    // Two runs from the same start do not pick the same people: it really is random.
    const firstRun = JSON.stringify(draws);
    state.lateShiftDraws = {};
    days.forEach((d) => { state.lateShiftDraws[d] = drawLateShift(d); });
    out.random = JSON.stringify(days.map((d) => state.lateShiftDraws[d].people)) !== firstRun;

    // Too few people to rest anybody: the list must still change, and still fill the shift.
    const keep = state.lateShiftDraws, keepStaff = state.staff;
    state.staff = keepStaff.filter((p) => ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].indexOf(p.id) >= 0);
    state.lateShiftDraws = {};
    days.forEach((d) => { state.lateShiftDraws[d] = drawLateShift(d); });
    const small = days.map((d) => state.lateShiftDraws[d].people);
    out.smallSizes = small.map((x) => x.length);
    out.smallSame = small.slice(1).some((x, i) => JSON.stringify(x) === JSON.stringify(small[i]));
    state.staff = keepStaff; state.lateShiftDraws = keep;

    // Everybody still works Thursday — the late shift takes nobody off the day.
    const thu = days[0];
    out.allWorkThu = state.staff.every((p) => worksOnDay(p, thu));

    // Drawn once: asking again does not re-roll a Thursday already picked.
    const firstPick = JSON.stringify(state.lateShiftDraws[thu].people);
    ensureLateShift();
    out.stable = JSON.stringify(state.lateShiftDraws[thu].people) === firstPick;

    // THE ROTA: the next four Thursdays are always picked, each different from the last.
    state.lateShiftDraws = {};
    ensureLateShift();
    const rota = lateShiftDays();
    out.rotaDays = rota.length === 4 && rota.every((d) => dowOf(d) === 4 && state.lateShiftDraws[d]);
    const rp = rota.map((d) => state.lateShiftDraws[d].people);
    out.rotaChanges = !rp.slice(1).some((x, i) => x.some((id) => rp[i].indexOf(id) >= 0));
    const before = JSON.stringify(state.lateShiftDraws);
    out.rotaStill = ensureLateShift() === false && JSON.stringify(state.lateShiftDraws) === before;
    state.tab = 'team'; render();
    const shown = document.body.innerText;
    out.rotaShown = shown.toLowerCase().indexOf('thursday rota') >= 0
      && rota.every((d) => shown.indexOf(fmtDay(d)) >= 0 && shown.indexOf(lateShiftNames(state.lateShiftDraws[d])) >= 0);

    // Somebody on the third Thursday leaves: they come off the rota, the first two stand.
    // A fixed rota and an assistant: a sole leader leaving takes their whole team out of
    // the pool, which rightly re-picks more than the one Thursday.
    const fixed = [['L0', 'L1', 'L2', 'L3'], ['L4', 'L5', 'A0', 'H0'], ['H1', 'H2', 'L0', 'L1'], ['L2', 'L3', 'L4', 'L5']];
    rota.forEach((d, i) => { state.lateShiftDraws[d] = { people: fixed[i], pool: lateShiftPool(), drawnAt: 'x' }; });
    const leaver = 'H1';
    const staffWas = state.staff, keepFirst = JSON.stringify(rota.slice(0, 2).map((d) => state.lateShiftDraws[d].people));
    state.staff = staffWas.filter((p) => p.id !== leaver);
    ensureLateShift();
    out.leaverGone = rota.slice(2).every((d) => state.lateShiftDraws[d].people.indexOf(leaver) < 0 && state.lateShiftDraws[d].people.length === 4 && state.lateShiftDraws[d].redrawnAt);
    out.earlierStand = JSON.stringify(rota.slice(0, 2).map((d) => state.lateShiftDraws[d].people)) === keepFirst;
    state.staff = staffWas;

    // A new headcount reaches the whole rota.
    setLateShiftPer(3);
    out.perApplied = rota.every((d) => state.lateShiftDraws[d].people.length === 3 && state.lateShiftDraws[d].redrawnAt);
    setLateShiftPer(4);

    // The Friday draw still works through the shared helper.
    const fri = drawFriday(shiftDay(thu, 1));
    out.fridayGot = { teams: fri.teams, pool: fri.pool };
    out.friday = fri.teams.length >= 1 && fri.pool.length === rotaTeams().length && fri.teams.every((x) => fri.pool.indexOf(x) >= 0);

    // The names the crew reads: two words each, because two people can share a first name.
    out.names = lateShiftNames({ people: ['L3', 'H0'], pool: lateShiftPool() });

    // Today's board and the Team tab say it, when today is a late-shift day.
    state.lateShiftDraws[workToday()] = { people: ['L1', 'H0'], pool: lateShiftPool(), drawnAt: new Date().toISOString() };
    state.tab = 'board'; render();
    out.board = document.body.innerText.indexOf('Late shift 10:00–20:00') >= 0
      && document.body.innerText.indexOf('Helper One, Leader1 Surname') >= 0;
    state.tab = 'team'; render();
    out.teamTab = document.body.innerText.toLowerCase().indexOf('thursday rota') >= 0;

    // Switched off, nothing shows anywhere.
    setLateShift(false);
    state.tab = 'board'; render();
    out.offAfter = lateShiftFor(workToday()) === null && document.body.innerText.indexOf('Late shift') < 0;
    return out;
  });

  check('off until it is switched on', q.offBefore);
  check('the first late Thursday is a Thursday at least 3 days out', q.from.dow === 4 && q.from.gap >= 3, JSON.stringify(q.from));
  check('hours are 10:00–20:00', q.from.hours.start === '10:00' && q.from.hours.end === '20:00');
  check('four people every Thursday', q.sizes.every((n) => n === 4), JSON.stringify(q.sizes));
  check('it changes every week — nobody stays late two Thursdays running', !q.backToBack);
  check('it is random — a second run picks differently', q.random);
  check('turns come out even — nobody more than one ahead over 12 Thursdays', Object.values(q.count).length === q.poolSize && Math.max(...Object.values(q.count)) - Math.min(...Object.values(q.count)) <= 1, JSON.stringify(q.count));
  check('the outside pair is never picked', !q.outsideEver);
  check('Lead is never picked', !q.bossEver);
  check('with too few to rest anybody the shift still fills and still changes', q.smallSizes.every((n) => n === 4) && !q.smallSame, JSON.stringify(q.smallSizes));
  check('everybody still works Thursday', q.allWorkThu);
  check('a picked Thursday is not re-rolled', q.stable);
  check('the Friday draw still works', q.friday, JSON.stringify(q.fridayGot));
  console.log('         friday: ' + q.fridayGot.teams.length + ' of ' + q.fridayGot.pool.length);
  check('the next four Thursdays are always on the rota', q.rotaDays);
  check('nobody is on two Thursdays running on the rota', q.rotaChanges);
  check('opening the app again changes nothing on the rota', q.rotaStill);
  check('the Team tab shows the rota, dates and names', q.rotaShown);
  check('somebody who leaves comes off the rota, and the shift stays full', q.leaverGone);
  check('Thursdays before the leaver stand', q.earlierStand);
  check('a new headcount reaches the whole rota', q.perApplied);
  check('names read "Helper One, Leader3 Surname"', q.names === 'Helper One, Leader3 Surname', q.names);
  check('the board names the late people and their hours', q.board);
  check('the Team tab has the switch', q.teamTab);
  check('switched off, it is gone from the board', q.offAfter);
  check('no console errors', errs.length === 0, errs.join(' | '));

  const failed = results.filter((r) => !r[1]).length;
  console.log((results.length - failed) + ' passed, ' + failed + ' failed');
  await browser.close(); s.close();
  process.exit(failed ? 1 : 0);
})();
