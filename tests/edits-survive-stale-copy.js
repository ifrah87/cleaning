/**
 * A HAND EDIT IS NOT UNDONE BY A DEVICE THAT HAS NOT HEARD ABOUT IT.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/edits-survive-stale-copy.js
 *
 * The whole board travels as one blob and the last writer wins. On 24 Aug that meant a
 * copy from earlier in the morning pushed the old weekday sets back over eight rooms,
 * put Trash / Recycling back on the wall and took OFFSITE- 2 DHAGAX off it — no error,
 * nothing on screen, the board simply changed. Ticks and plans already had answers for
 * this. Edits and communal areas did not.
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
const YESTERDAY = key(new Date(Date.now() - 864e5));

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
// What the server holds when the phone opens: 401 weekly, and an area the office added.
const APP_STATE = {
  staff: [{ id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [4], hikPersonId: 'h1' }],
  servicedUnits: [{ id: 'su401', unit: '401', type: 'office', freq: 'weekly', lastCleaned: YESTERDAY }],
  areas: [
    { id: 'lobby', label: 'Main Lobby/Office', kind: 'interior', freq: 'daily', assignedTo: null },
    { id: 'offsite', label: 'OFFSITE- 2 DHAGAX', kind: 'interior', freq: 'daily', assignedTo: null },
  ],
  completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
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
    return json([]);
  });
  await ctx.addInitScript(([h, ss]) => { localStorage.setItem('sb-' + h.split('.')[0] + '-auth-token', JSON.stringify(ss)); }, [SUPA_HOST, SESSION]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.header', { timeout: 20000 });
  await page.waitForTimeout(2500);

  console.log('\n\x1b[1mAn edit is not undone by a copy that predates it\x1b[0m');

  const r = await page.evaluate((stale) => {
    const u = state.servicedUnits.find((x) => x.unit === '401');
    // The office edits on this device: frequency to daily, and takes an area off.
    // removeArea asks first, so the question is answered yes for the length of the call.
    setUnitFreq(u.id, 'daily');
    const ask = window.showConfirm;
    window.showConfirm = (t, b, fn) => fn();
    removeArea('lobby');
    window.showConfirm = ask;
    const editedAt = state.servicedUnits.find((x) => x.unit === '401').editedAt;
    // The server confirmed the write, so this device has nothing owed and will accept
    // an incoming copy rather than pushing over it.
    localStorage.removeItem('cleaning_app_v5_dirty');
    // ...and now a copy from BEFORE the edit arrives from another device.
    applyRemote(stale);
    const after = state.servicedUnits.find((x) => x.unit === '401');
    return {
      editedAt: editedAt || null,
      freq: after.freq,
      days: after.days || null,
      areas: state.areas.map((a) => a.label),
      tombstoned: Object.keys(state.removedAreas || {}),
    };
  }, { ...APP_STATE, _fromAnotherDevice: 1 }).catch((e) => ({ error: String(e), areas: [], tombstoned: [] }));

  check('the edit is stamped with the moment it was made', !!r.editedAt, JSON.stringify(r));
  check('a stale copy does not put the old frequency back', r.freq === 'daily', 'freq is ' + r.freq);
  check('an area the office added is still there', (r.areas || []).includes('OFFSITE- 2 DHAGAX'), (r.areas || []).join(', '));
  check('an area the office deleted does not come back', !(r.areas || []).includes('Main Lobby/Office'), (r.areas || []).join(', '));
  check('and the deletion is recorded so it keeps biting', (r.tombstoned || []).includes('lobby'), JSON.stringify(r.tombstoned));
  // --- a morning arranged by hand is not undone by an older copy --------------------
  const plan = await page.evaluate((stale) => {
    const day = workToday();
    // Lay a day out and hand one job to somebody, here, now.
    togglePlanJob(day, 'unit', 'su401', 'Unit 401');
    const k = Object.keys(state.plans[day])[0];
    setPlanAssignee(day, k, 'p1');
    const mine = JSON.parse(JSON.stringify(state.plans[day]));
    localStorage.removeItem('cleaning_app_v5_dirty');
    // A device that still holds the day as it was before pushes its copy.
    const older = JSON.parse(JSON.stringify(stale));
    older.plans = { [day]: {} };
    older.planEdited = { [day]: '2000-01-01T00:00:00.000Z' };
    older._fromAnotherDevice = 2;
    applyRemote(older);
    return { after: state.plans[day], mineKeys: Object.keys(mine) };
  }, { ...APP_STATE, _fromAnotherDevice: 1 }).catch((e) => ({ error: String(e) }));
  check('a plan made by hand survives an older copy landing on it',
    plan.after && Object.keys(plan.after).length === plan.mineKeys.length, JSON.stringify(plan));

  // --- a device that cannot send does not go deaf for ever -------------------------
  const deaf = await page.evaluate((stale) => {
    markDirty();
    try { localStorage.setItem('cleaning_app_v5_dirty_since', String(Date.now() - 5 * 60 * 1000)); } catch (e) {}
    const incoming = JSON.parse(JSON.stringify(stale));
    incoming._fromAnotherDevice = 3;
    incoming.floors = 12;                       // something plainly new to notice
    applyRemote(incoming);
    return { floors: state.floors, stillOwed: isDirty() };
  }, { ...APP_STATE, _fromAnotherDevice: 1 }).catch((e) => ({ error: String(e) }));
  check('after two minutes stuck, an incoming copy is taken', deaf.floors === 12, JSON.stringify(deaf));
  check('and what it owed is still owed', deaf.stillOwed === true, JSON.stringify(deaf));

  // --- THE ROSTER SURVIVES A STALE COPY, THE SAME WAY THE ROOMS DO -----------------
  // The floor map was wiped twice in two days: the whole state travels as one blob, and
  // staff was the one collection with no merge behind it, so a device whose roster
  // predated the floors pushed its own and took every floor with it.
  const roster = await page.evaluate((stale) => {
    setFloorOwner(7, 'p1');                                  // give Amina floor 7 here
    const before = (state.staff.find((x) => x.id === 'p1').floors || []).slice();
    const stamped = !!state.staff.find((x) => x.id === 'p1').editedAt;
    const old = JSON.parse(JSON.stringify(stale));           // a copy that never saw it
    old._fromAnotherDevice = 9;
    applyRemote(old);
    const p = state.staff.find((x) => x.id === 'p1');
    return { before, stamped, after: (p && p.floors) || [], names: state.staff.map((x) => x.name) };
  }, APP_STATE).catch((e) => ({ error: String(e) }));
  check('a floor handed to somebody is stamped with the moment it happened',
    roster.stamped === true, JSON.stringify(roster));
  check('and a roster that never saw it cannot take the floor back',
    JSON.stringify(roster.after) === JSON.stringify(roster.before), JSON.stringify(roster));
  check('the seeded demo crew is not smuggled onto a real building',
    !(roster.names || []).some((n) => /Sofia Reyes|Jamal Brooks|Marcus Hill/.test(n)),
    JSON.stringify(roster.names));

  // --- somebody taken off the roster stays off it ----------------------------------
  const gone = await page.evaluate((stale) => {
    const u = state.servicedUnits.find((x) => x.unit === '401');
    u.assignedTo = 'p1'; u.usualTo = 'p1';                   // their room and their pin
    const ask = window.showConfirm;
    window.showConfirm = (t, b, onYes) => onYes();           // take the confirm as read
    removeEmployee('p1');
    window.showConfirm = ask;
    const afterDelete = state.staff.map((x) => x.id);
    const room = state.servicedUnits.find((x) => x.unit === '401');
    const held = { assignedTo: room.assignedTo, usualTo: room.usualTo };
    const old = JSON.parse(JSON.stringify(stale));           // a copy that still has them
    old._fromAnotherDevice = 10;
    applyRemote(old);
    return { afterDelete, held, back: state.staff.map((x) => x.id),
             tomb: !!(state.removedStaff || {}).p1 };
  }, APP_STATE).catch((e) => ({ error: String(e) }));
  check('removing somebody takes them off the roster', !(gone.afterDelete || []).includes('p1'),
    JSON.stringify(gone));
  check('and hands back the room they were holding, tie and all',
    gone.held && gone.held.assignedTo === null && gone.held.usualTo === null, JSON.stringify(gone.held));
  check('it is written down that they went on purpose', gone.tomb === true, JSON.stringify(gone));
  check('so a copy that still has them cannot bring them back',
    !(gone.back || []).includes('p1'), JSON.stringify(gone.back));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
