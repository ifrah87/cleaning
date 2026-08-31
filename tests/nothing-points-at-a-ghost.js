/**
 * NOTHING POINTS AT SOMETHING THAT IS NOT THERE.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/nothing-points-at-a-ghost.js
 *
 * Removing a person, a room, a walk or a team handed back what was theirs AT THAT MOMENT
 * and stopped. So a copy of the board from before the removal, arriving later, put every
 * one of those names straight back — and because the tombstone correctly kept the person
 * off the roster, there was no column for any of it to appear on. Three rooms and a
 * communal walk sat in NOBODY YET against a name with nobody behind it, and two of them
 * were never cleaned. A dangling reference is worse than an empty one: empty is visible,
 * and somebody picks it up.
 *
 * So on every load — the boot from this device's own copy and every merge from the
 * server, which both come through finalizeState — anything naming something that is no
 * longer there is handed back.
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
const DAY_BEFORE = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 2 : 1)); while (d.getDay() === 5) d.setDate(d.getDate() - 1); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

// A board carrying every kind of ghost at once: a room and a walk held by somebody who
// is off the roster, a tie to them, a plan naming them, a plan job for a room that no
// longer exists, a cover pointing at a deleted room, and a cleaner on a team that has
// been taken away.
const APP_STATE = {
  staff: [
    { id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [4], hikPersonId: 'h1' },
    { id: 'p2', name: 'Hodan Omar', crew: 'Vanished Team', isCleaner: true, isLeader: true, floors: [3], hikPersonId: 'h2' },
  ],
  teams: [{ name: 'Team A', color: '#0284c7' }],       // ...and no Vanished Team
  removedStaff: { pGONE: WORK_TODAY },                  // archived, correctly off the roster
  servicedUnits: [
    { id: 'su401', unit: '401', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'pGONE', usualTo: 'pGONE' },
    { id: 'su402', unit: '402', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'pNEVER' },
    { id: 'su403', unit: '403', type: 'office', freq: 'daily', lastCleaned: DAY_BEFORE, assignedTo: 'p1', usualTo: 'p1' },
  ],
  areas: [
    { id: 'lobby', label: 'Main Lobby/Office', kind: 'interior', freq: 'daily', assignedTo: 'pGONE' },
    { id: 'corridors', label: 'Corridors', kind: 'interior', freq: 'daily', assignedTo: 'p1', assignedWith: ['pGONE', 'p2'] },
  ],
  plans: {
    [WORK_TODAY]: {
      'unit:su401': { kind: 'unit', refId: 'su401', label: '401', assignedTo: 'pGONE', byHand: true },
      'unit:su403': { kind: 'unit', refId: 'su403', label: '403', assignedTo: 'p1' },
      'unit:suDELETED': { kind: 'unit', refId: 'suDELETED', label: '909', assignedTo: 'p1' },
      'area:lobby': { kind: 'area', refId: 'lobby', label: 'Main Lobby/Office', assignedTo: 'pGONE' },
      'area:areaDELETED': { kind: 'area', refId: 'areaDELETED', label: 'Old Walk', assignedTo: 'p1' },
    },
  },
  unitCover: { su401: 'pGONE', suDELETED: 'p1' },
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
};
const EVENTS = [{ person_name: 'Amina Yusuf', person_code: '1', event_time: WORK_TODAY + ' 06:30:00' }];

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
        const row = { data: APP_STATE, updated_at: '2026-08-31T06:00:00.000Z' };
        return json(single ? row : [row]);
      }
      return json([{ updated_at: new Date().toISOString() }], 201);
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

  console.log('\n\x1b[1mNothing points at somebody, or something, that is not there\x1b[0m');

  const r = await page.evaluate(() => {
    const plan = (state.plans || {})[workToday()] || {};
    const u = (n) => (state.servicedUnits || []).find((x) => x.unit === n) || {};
    const a = (id) => (state.areas || []).find((x) => x.id === id) || {};
    return {
      u401: { assignedTo: u('401').assignedTo || null, usualTo: u('401').usualTo || null },
      u402: { assignedTo: u('402').assignedTo || null },
      u403: { assignedTo: u('403').assignedTo || null, usualTo: u('403').usualTo || null },
      lobby: a('lobby').assignedTo || null,
      corridorsWith: a('corridors').assignedWith || null,
      corridorsOwner: a('corridors').assignedTo || null,
      planKeys: Object.keys(plan).sort(),
      plan401: (plan['unit:su401'] || {}).assignedTo || null,
      plan401ByHand: !!(plan['unit:su401'] || {}).byHand,
      plan403: (plan['unit:su403'] || {}).assignedTo || null,
      cover: state.unitCover || {},
      teams: (state.teams || []).map((t) => t.name).sort(),
      crewOfP2: ((state.staff || []).find((p) => p.id === 'p2') || {}).crew || null,
      // Every place a person can be named, swept for the two ghosts.
      ghostRefs: (() => {
        const hit = [];
        (state.servicedUnits || []).forEach((x) => {
          [x.assignedTo, x.usualTo].forEach((v) => { if (v === 'pGONE' || v === 'pNEVER') hit.push(v); });
        });
        (state.areas || []).forEach((x) => {
          [x.assignedTo].concat(x.assignedWith || []).forEach((v) => {
            if (v === 'pGONE' || v === 'pNEVER') hit.push(v);
          });
        });
        Object.values(state.plans || {}).forEach((d) => Object.values(d || {}).forEach((j) => {
          if (j && (j.assignedTo === 'pGONE' || j.assignedTo === 'pNEVER')) hit.push(j.assignedTo);
        }));
        Object.values(state.unitCover || {}).forEach((v) => {
          if (v === 'pGONE' || v === 'pNEVER') hit.push(v);
        });
        return hit;
      })(),
      // Put a ghost back on a room and run the scrub on its own, so the handing back is
      // watched rather than inferred from a board several passes have since touched.
      direct: (() => {
        // Guarded so that on a build without the function the OTHER checks still get to
        // report, instead of the whole run dying on a ReferenceError.
        if (typeof scrubDanglingReferences !== 'function') return { missing: true };
        const x = (state.servicedUnits || []).find((y) => y.unit === '403');
        x.assignedTo = 'pGONE'; x.usualTo = 'pGONE';
        const n = scrubDanglingReferences();
        return { assignedTo: x.assignedTo || null, usualTo: x.usualTo || null, n };
      })(),
    };
  });

  // Asked as "is the ghost still referenced anywhere", not "is the room unassigned":
  // a room handed back is free, and the morning pass then quite rightly deals it to
  // somebody real. Checking it was still empty afterwards would be testing the hand-out,
  // and would fail for the very reason the scrub worked.
  check('no room anywhere still names the archived person',
    !r.ghostRefs.includes('pGONE'), JSON.stringify(r.ghostRefs));
  check('...and the tie to them goes with it', r.u401.usualTo === null, JSON.stringify(r.u401));
  check('nor a name that was never on the roster at all',
    !r.ghostRefs.includes('pNEVER'), JSON.stringify(r.ghostRefs));
  // ...and the handing back itself, watched directly rather than inferred.
  check('the scrub hands a ghost-held room back to nobody',
    r.direct && r.direct.assignedTo === null && r.direct.usualTo === null && r.direct.n > 0,
    JSON.stringify(r.direct));
  check('a communal walk held by an archived name is handed back',
    r.lobby === null, JSON.stringify({ lobby: r.lobby }));
  check('...and they are dropped from a walk they were named alongside on',
    Array.isArray(r.corridorsWith) && !r.corridorsWith.includes('pGONE'),
    JSON.stringify(r.corridorsWith));
  check('but the live person named alongside stays on it',
    Array.isArray(r.corridorsWith) && r.corridorsWith.includes('p2'),
    JSON.stringify(r.corridorsWith));
  check('a planned job against an archived name is handed back',
    r.plan401 === null && r.plan401ByHand === false, JSON.stringify(r));
  check('a planned job for a room that no longer exists is dropped',
    !r.planKeys.includes('unit:suDELETED'), JSON.stringify(r.planKeys));
  check('a planned job for a walk that no longer exists is dropped',
    !r.planKeys.includes('area:areaDELETED'), JSON.stringify(r.planKeys));
  check('a cover pointing at a deleted room is dropped',
    !('suDELETED' in r.cover) && !('su401' in r.cover), JSON.stringify(r.cover));

  // The team is the one case repaired the other way round: taking somebody's crew away
  // would take them off the board altogether, which is worse than the problem.
  check('a crew with no team behind it has the team put back',
    r.teams.includes('Vanished Team'), JSON.stringify(r.teams));
  check('...and nobody loses their crew doing it',
    r.crewOfP2 === 'Vanished Team', String(r.crewOfP2));

  // ...and none of it touches work that is perfectly fine.
  check('a room held by somebody real is left alone',
    r.u403.assignedTo === 'p1' && r.u403.usualTo === 'p1', JSON.stringify(r.u403));   // read before the direct check ghosts it
  check('a live planned job is left alone', r.plan403 === 'p1', String(r.plan403));
  check('and a walk still has its live owner', r.corridorsOwner === 'p1', String(r.corridorsOwner));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
