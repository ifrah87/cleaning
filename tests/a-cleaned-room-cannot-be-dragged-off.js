/**
 * A CLEANED ROOM STAYS WITH WHOEVER CLEANED IT.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/a-cleaned-room-cannot-be-dragged-off.js
 *
 * 17 Nov 2026: 705, ticked by Adan at 10:15, was dragged onto Ahmed Daahir at 13:40 and the
 * wall showed Ahmed as having cleaned it. A board move of a finished room is refused;
 * a room not yet cleaned still moves exactly as before.
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
const SESSION = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', aud: 'authenticated', role: 'authenticated' } };
const APP_STATE = {
  staff: [
    { id: 'pa', name: 'Adan Abdullahi Nur', crew: 'Team A', isCleaner: true, isLeader: true, floors: [7] },
    { id: 'pb', name: 'Ahmed Daahir', crew: 'Team B', isCleaner: true, isLeader: true, floors: [4] },
  ],
  servicedUnits: [
    { id: 'su705', unit: '705', type: 'office', freq: 'daily', lastCleaned: WORK_TODAY, lastCleanedBy: 'pa', lastCleanedByName: 'Adan Abdullahi Nur', assignedTo: 'pa' },
    { id: 'su704', unit: '704', type: 'office', freq: 'daily', lastCleaned: '2026-01-01', assignedTo: 'pa' },
  ],
  areas: [], completions: {}, assignConfirmed: {}, manualArrivals: {}, floors: 11,
};
const EVENTS = [
  { person_name: 'Adan Abdullahi Nur', person_code: '1', event_time: WORK_TODAY + ' 06:30:00' },
  { person_name: 'Ahmed Daahir', person_code: '2', event_time: WORK_TODAY + ' 06:40:00' },
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
      if (m === 'GET') { const single = String(req.headers()['accept'] || '').includes('pgrst.object'); return json(single ? { data: APP_STATE } : [{ data: APP_STATE }]); }
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

  console.log('\n\x1b[1mA cleaned room stays with whoever cleaned it\x1b[0m');
  const r = await page.evaluate(() => {
    const u = () => state.servicedUnits.find((x) => x.id === 'su705');
    u().assignedTo = 'pa'; state.assignConfirmed.su705 = todayKey();   // on Adan's column, as on the wall
    const before = { done: cleanedToday(u()), who: u().assignedTo };
    assignPicked('unit', 'su705', 'pb');
    const after = u().assignedTo;
    const told = !!document.getElementById('confirmModal');
    dismissConfirmModal();
    assignPicked('unit', 'su704', 'pb');
    const moved = state.servicedUnits.find((x) => x.id === 'su704').assignedTo;
    return { before, after, told, moved };
  });
  check('705 starts out cleaned by Adan', r.before.done && r.before.who === 'pa', JSON.stringify(r));
  check('dragging it onto Ahmed is refused', r.after === 'pa', JSON.stringify(r));
  check('...and the board says why', r.told, JSON.stringify(r));
  check('a room not yet cleaned still moves', r.moved === 'pb', JSON.stringify(r));
  check('no console errors', errs.length === 0, errs.join('\n       '));
  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
