/**
 * A BOARD THAT HIDES WORK MUST SAY SO.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/the-wall-cannot-hide-work.js
 *
 * Every card on the television gets one equal cell of a grid, and tvFitColumns shrinks
 * the whole board until the tallest one fits. Past a floor of 0.28 it gives up — and
 * the card then simply cut itself off. No mark, no count, nothing: .tv-col was
 * overflow:hidden and anything appended to admit it was itself below the fold.
 *
 * The box most likely to overflow is NOBODY YET, whose entire job is to show work that
 * nobody has been given. So the one part of the wall that exists to say "this is not
 * being done" was the part that silently stopped saying it, and the board looked
 * complete while rooms fell off the bottom of the screen.
 *
 * Two things are checked here: that the unassigned box is given the WIDTH to lay its
 * chips out before anything is cut at all, and that when a card does still clip it
 * says how much it is not showing.
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
// Two days back: a room cleaned on the Friday is not due again on the Saturday.
const PREV = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 3 ? 3 : 2)); return key(d); })();

const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };

// Four cleaners with a small round each, and a great pile of rooms nobody has been
// given — the shape of a morning where half the crew has rung in sick.
const staff = [];
for (let i = 1; i <= 4; i += 1) {
  staff.push({ id: 'p' + i, name: 'Cleaner Number ' + i, crew: 'Team ' + i, isCleaner: true, isLeader: true, floors: [i], hikPersonId: 'h' + i });
}
const servicedUnits = [];
for (let i = 1; i <= 4; i += 1) {
  servicedUnits.push({ id: 'own' + i, unit: String(i) + '01', type: 'office', freq: 'daily', lastCleaned: PREV, assignedTo: 'p' + i });
}
// Six hundred rooms in NOBODY YET — far past anything the building could produce, and
// deliberately so: the board shrinks to fit whatever it is given, so the only way to
// reach the give-up floor at all is to hand it more than shrinking can ever solve. Far more than any television can draw at a
// size anybody could read from across the office — which is the point: the board must
// shrink as far as it is allowed to, give up, and then SAY what it could not fit.
for (let i = 0; i < 600; i += 1) {
  servicedUnits.push({ id: 'loose' + i, unit: '9' + String(1000 + i), type: 'office', freq: 'daily', lastCleaned: PREV });
}
const APP_STATE = {
  staff, servicedUnits,
  areas: [], completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
  autoAssign: false, autoBalance: false, autoConfirm: true,
  rollCallTypes: ['office', 'building'],
};
const EVENTS = staff.map((p, i) => ({ person_name: p.name, person_code: String(i + 1), event_time: WORK_TODAY + ' 06:0' + i + ':00' }));

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
  await page.waitForTimeout(3000);

  console.log('\n\x1b[1mThe wall cannot hide work\x1b[0m');

  const shape = await page.evaluate(() => {
    const none = document.querySelector('.tv-col.none');
    return {
      cols: document.querySelectorAll('.tv-col').length,
      none: !!none,
      span: !!none && none.classList.contains('span2'),
      across: (getComputedStyle(document.querySelector('.tv-cols')).gridTemplateColumns || '').split(' ').length,
    };
  });
  check('the unassigned box is on the board at all', shape.none, JSON.stringify(shape));
  check('...and is given two columns, being the biggest card there',
    shape.span, JSON.stringify(shape));
  check('...with the extra cell counted, so the grid still has room for everybody',
    shape.cols + 1 <= shape.across * 3, JSON.stringify(shape));

  // The point of the whole exercise: nothing is cut off without the card saying so.
  // Asked as a comparison of two heights, which is the same answer wherever it is taken
  // from — unlike counting chips against a clip edge, which is half a pixel of luck.
  const clip = await page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('.tv-col').forEach((c) => {
      const box = c.querySelector('.tv-body');
      if (!box) return;
      const cut = box.scrollHeight > box.clientHeight + 1;
      const mark = c.querySelector('.tv-more');
      rows.push({ name: c.querySelector('.tv-who').textContent, cut, said: mark ? mark.textContent : null });
    });
    return rows;
  });
  check('a card that cuts work off says so',
    clip.some((c) => c.cut) && clip.filter((c) => c.cut).every((c) => c.said === '▾ MORE BELOW'),
    JSON.stringify(clip));
  check('...and the card’s corner still carries the true total, cut or not',
    await page.evaluate(() => (document.querySelector('.tv-col.none .tv-count') || {}).textContent) === '0/600',
    await page.evaluate(() => (document.querySelector('.tv-col.none .tv-count') || {}).textContent));

  // ...and the line that admits it must itself be on the screen, which is the bug that
  // made the old attempt useless: appended inside the clipping box, below the fold.
  const visible = await page.evaluate(() => {
    const marks = [].slice.call(document.querySelectorAll('.tv-more'));
    return marks.map((m) => {
      const r = m.getBoundingClientRect(), c = m.closest('.tv-col').getBoundingClientRect();
      return { t: m.textContent, inside: r.bottom <= c.bottom + 1 && r.height > 0 };
    });
  });
  check('...and that line is inside its own card, where it can be read',
    visible.length > 0 && visible.every((m) => m.inside), JSON.stringify(visible));

  // A card that fits must not gain a marker it has no need for.
  const spurious = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('.tv-col').forEach((c) => {
      const box = c.querySelector('.tv-body');
      if (!box || !c.querySelector('.tv-more')) return;
      if (box.scrollHeight <= box.clientHeight + 1) bad.push(c.querySelector('.tv-who').textContent);
    });
    return bad;
  });
  check('a card that fits carries no marker', spurious.length === 0, JSON.stringify(spurious));

  // And with a normal morning — nothing loose — nothing is marked and nothing spans.
  const calm = await page.evaluate(() => {
    state.servicedUnits.forEach((u, i) => { if (!u.assignedTo) u.assignedTo = 'p' + ((i % 4) + 1); });
    state.servicedUnits = state.servicedUnits.slice(0, 12);
    render();
    return new Promise((r) => setTimeout(() => r({
      none: !!document.querySelector('.tv-col.none'),
      span: !!document.querySelector('.tv-col.span2'),
      marks: document.querySelectorAll('.tv-more').length,
    }), 400));
  });
  check('a morning where everything is handed out has no unassigned box at all',
    !calm.none && !calm.span, JSON.stringify(calm));
  check('...and nothing on the wall claims to be hiding anything',
    calm.marks === 0, JSON.stringify(calm));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
