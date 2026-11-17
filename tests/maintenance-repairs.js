/**
 * REPAIRS ARE NOT CLEANING.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/maintenance-repairs.js
 *
 * A broken AC, a leak, a light out — reported by the office, fixed by an outside
 * contractor. It stays open until somebody says it is fixed, urgent ones first, and it
 * never lands in a cleaner's column or the day's job count. It has its own tab on the
 * phone and its own page on the TV.
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
const AGO = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return key(d); };
const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const APP_STATE = {
  staff: [{ id: 'p1', name: 'Amina Yusuf', crew: 'Team A', isCleaner: true, isLeader: true, floors: [1], hikPersonId: 'h1' }],
  servicedUnits: [{ id: 'su101', unit: '101', type: 'building', freq: 'daily', lastCleaned: AGO(1), assignedTo: 'p1' }],
  areas: [{ id: 'lobby', label: 'Lobby', kind: 'interior', freq: 'daily', assignedTo: 'p1' }],
  // Reported five days ago, not urgent, nobody has come yet.
  maintenance: [{ id: 'mjold', what: 'Door handle loose', where: 'Room 101', who: '', urgent: false, raisedOn: AGO(5), doneOn: null, editedAt: '2026-01-01T00:00:00.000Z' }],
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
  await page.waitForTimeout(3000);

  console.log('\n\x1b[1mRepairs have their own list\x1b[0m');

  const nav = await page.evaluate(() => NAV_GROUPS.flatMap(([, items]) => items.map((i) => i[0])));
  check('Maintenance is on the menu', nav.includes('maintenance'), nav.join(', '));

  await page.evaluate(() => { setTab('maintenance'); render(); });
  await page.waitForTimeout(500);
  let body = await page.locator('.body').first().textContent();
  check('the tab opens with a form to report a repair', body.includes('Report a repair'), body.slice(0, 200));
  check('and the repair already reported is listed as open', body.includes('Door handle loose') && /open 5 days/i.test(body), body.slice(0, 400));

  // Report one through the form, the way the office would.
  await page.fill('input[placeholder^="What is wrong"]', 'AC not cooling');
  await page.fill('input[placeholder^="Where"]', 'Room 101');
  await page.fill('input[placeholder^="Contractor"]', 'Cool Air Ltd');
  await page.click('button:has-text("Urgent")');
  await page.click('button:has-text("Add repair")');
  await page.waitForTimeout(500);

  const added = await page.evaluate(() => {
    const m = state.maintenance.find((x) => x.what === 'AC not cooling');
    return { m, order: maintOpen().map((x) => x.what), today: todayKey() };
  });
  check('the form saves the repair', !!added.m, JSON.stringify(added));
  check('with where, who and urgency', added.m && added.m.where === 'Room 101' && added.m.who === 'Cool Air Ltd' && added.m.urgent === true, JSON.stringify(added.m));
  check('stamped with today and an edit time', added.m && added.m.raisedOn === added.today && !!added.m.editedAt, JSON.stringify(added.m));
  check('an urgent repair goes above an older normal one', added.order[0] === 'AC not cooling', added.order.join(' | '));
  body = await page.locator('.body').first().textContent();
  check('the form is empty again for the next one', (await page.inputValue('input[placeholder^="What is wrong"]')) === '', '');

  console.log('\n\x1b[1mIt is not cleaning work\x1b[0m');
  const notCleaning = await page.evaluate(() => {
    const jobs = tvColumns().flatMap((c) => c.jobs).map((j) => j.label);
    return { jobs, areas: areasInterior().map((a) => a.label) };
  });
  check('no repair lands in a cleaner’s column', !notCleaning.jobs.some((l) => /AC not cooling|Door handle/.test(String(l))), notCleaning.jobs.join(', '));
  check('or among the communal areas', !notCleaning.areas.some((l) => /AC not cooling|Door handle/.test(l)), notCleaning.areas.join(', '));

  console.log('\n\x1b[1mThe TV has a page for it\x1b[0m');
  const tv = await page.evaluate(() => {
    const pages = tvPageList().map((p) => p.key);
    const box = tvMaintPage();
    return { pages, text: box.textContent, cards: box.querySelectorAll('.tv-stay').length };
  });
  check('a REPAIRS page while anything is open', tv.pages.includes('maint'), tv.pages.join(', '));
  check('one card per open repair', tv.cards === 2, String(tv.cards));
  check('showing where, what, and that it is urgent', /ROOM 101/.test(tv.text) && /AC not cooling/.test(tv.text) && /URGENT/.test(tv.text), tv.text);

  console.log('\n\x1b[1mFixed, reopened, deleted\x1b[0m');
  const fixed = await page.evaluate(() => {
    maintOpen().forEach((m) => setMaint(m.id, { doneOn: todayKey() }));
    return { open: maintOpen().length, pages: tvPageList().map((p) => p.key) };
  });
  check('marking fixed takes it off the open list', fixed.open === 0, JSON.stringify(fixed));
  check('and the TV page goes when nothing is open', !fixed.pages.includes('maint'), fixed.pages.join(', '));
  body = await page.locator('.body').first().textContent();
  check('a fixed repair is still listed under Fixed', body.includes('Fixed · last 30 days') && body.includes('AC not cooling'), body.slice(0, 500));
  const reopened = await page.evaluate(() => {
    const m = state.maintenance.find((x) => x.what === 'AC not cooling');
    setMaint(m.id, { doneOn: null });
    return maintOpen().map((x) => x.what);
  });
  check('a repair can be reopened', reopened.includes('AC not cooling'), reopened.join(', '));

  console.log('\n\x1b[1mTwo phones at once\x1b[0m');
  const merge = await page.evaluate(() => {
    const mine = state.maintenance.find((x) => x.what === 'AC not cooling');
    // Another phone pushed a copy that has never heard of the AC repair, and that marked
    // the door handle fixed a minute ago.
    const theirs = JSON.parse(JSON.stringify(state));
    theirs.maintenance = [{ id: 'mjold', what: 'Door handle loose', where: 'Room 101', who: 'Ali', urgent: false,
      raisedOn: '2026-01-01', doneOn: todayKey(), editedAt: new Date(Date.now() + 60000).toISOString() }];
    theirs.removedMaintenance = {};
    theirs._probe = Math.random();
    applyRemote(theirs, true);
    const a = state.maintenance.find((x) => x.id === mine.id);
    const b = state.maintenance.find((x) => x.id === 'mjold');
    return { keptMine: !!a, theirEditWon: !!(b && b.doneOn && b.who === 'Ali') };
  });
  check('a repair the server has not seen yet survives another phone’s save', merge.keptMine, JSON.stringify(merge));
  check('the newer edit from the other phone wins', merge.theirEditWon, JSON.stringify(merge));

  const deleted = await page.evaluate(() => {
    const id = state.maintenance.find((x) => x.what === 'AC not cooling').id;
    const copy = JSON.parse(JSON.stringify(state.maintenance.find((x) => x.id === id)));
    state.maintenance = state.maintenance.filter((x) => x.id !== id);
    state.removedMaintenance = { ...(state.removedMaintenance || {}), [id]: todayKey() };
    // A stale phone still holds it and pushes it back.
    const theirs = JSON.parse(JSON.stringify(state));
    theirs.maintenance = theirs.maintenance.concat([copy]);
    theirs.removedMaintenance = {};
    theirs._probe = Math.random();
    applyRemote(theirs, true);
    return state.maintenance.some((x) => x.id === id);
  });
  check('a deleted repair does not come back from a stale phone', deleted === false, '');

  check('no console errors', errs.length === 0, errs.join('\n       '));
  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
