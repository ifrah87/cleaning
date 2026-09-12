/**
 * A PIN OUTRANKS A RANK.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/a-pin-outranks-a-rank.js
 *
 * The plan deals unpinned work to LEADERS only, and rightly so: naming an assistant on a
 * plan produces work nobody can carry. But that same filter was the list every pass
 * looked a PINNED owner up in — so a room tied to somebody who is not a leader could not
 * be given to them on their own round, and was quietly dealt to a leader instead.
 *
 * Abukar Daud Osman and Mahamed Abdi Abiker walk floor 8 together and neither is a
 * leader — neither CAN be, because two people are only drawn as one card when neither of
 * them is. On 12 Sep their five rooms were pinned to Abukar and Sunday's plan handed
 * 804, 903 and 1102 to Abdullahi Mohamed Abdi, who was already carrying his own floor.
 * The pair had no column at all on a day they were both rostered in, and the office
 * reasonably read it as the pins not having saved.
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
    // The pair. Neither is a leader, which is the whole reason they draw as one card.
    { id: 'pAbukar', name: 'Abukar Daud Osman', crew: 'Team H', isCleaner: true, hikPersonId: 'h2' },
    { id: 'pAbiker', name: 'Mahamed Abdi Abiker', crew: 'Team H', isCleaner: true, hikPersonId: 'h3' },
  ],
  servicedUnits: [
    { id: 'u105', unit: '105', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pLead' },
    { id: 'u804', unit: '804', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbukar', assignedWith: ['pAbiker'] },
    { id: 'u903', unit: '903', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbukar', assignedWith: ['pAbiker'] },
    { id: 'u1102', unit: '1102', type: 'office', freq: 'daily', lastCleaned: PREV, usualTo: 'pAbukar', assignedWith: ['pAbiker'] },
    // Tied to nobody: this one SHOULD go to a leader, which is what the filter is for.
    { id: 'u601', unit: '601', type: 'office', freq: 'daily', lastCleaned: PREV },
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

  console.log('\n\x1b[1mA pin outranks a rank\x1b[0m');

  const plan = await page.evaluate(() => {
    const day = shiftDay(workToday(), 1);
    // Built from scratch rather than topped up: seedPlanOnce will not re-seed a day it
    // has already done, so a deleted plan stays deleted and the test measures nothing.
    rebuildPlanDay(day);
    const uById = {}; (state.servicedUnits || []).forEach((u) => { uById[u.id] = u; });
    const out = {};
    Object.values(getPlan(day)).forEach((j) => {
      if (j.kind !== 'unit') return;
      out[uById[j.refId].unit] = j.assignedTo || null;
    });
    return out;
  });
  const dump = JSON.stringify(plan);

  check('a room pinned to somebody who is not a leader goes to them',
    plan['804'] === 'pAbukar' && plan['903'] === 'pAbukar' && plan['1102'] === 'pAbukar', dump);
  check('...so it is not quietly handed to a leader instead',
    plan['804'] !== 'pLead' && plan['903'] !== 'pLead' && plan['1102'] !== 'pLead', dump);
  check('a leader still keeps his own pinned room', plan['105'] === 'pLead', dump);
  check('...and work tied to nobody still goes to a leader, which is what the rule is for',
    plan['601'] === 'pLead', dump);

  // ...and the wall draws them as the pair they are, rather than leaving them off it.
  const cols = await page.evaluate(() => tvColumnsForDay(shiftDay(workToday(), 1))
    .map((c) => ({ name: c.name, rooms: c.jobs.map((j) => j.label) })));
  // A future day's board names the room's OWNER and does not merge a pair into one card —
  // that is the live board's job, off who is actually in. What matters here is that the
  // three rooms are on his column at all, which yesterday they were not.
  check('the pair get a column on that day, with their rooms on it',
    cols.some((c) => /Abukar/.test(c.name)
      && ['804', '903', '1102'].every((u) => c.rooms.some((l) => new RegExp('\\b' + u + '\\b').test(String(l))))),
    JSON.stringify(cols));
  check('...and the leader is not carrying them as well',
    !cols.some((c) => /Abdullahi/.test(c.name) && c.rooms.some((l) => /^(804|903|1102)/.test(l))),
    JSON.stringify(cols));

  check('no console errors', errs.length === 0, errs.join('\n       '));

  await browser.close(); s.close();
  const passed = out.filter((x) => x[1]).length;
  console.log(`\n${passed} passed, ${out.length - passed} failed`);
  process.exit(out.length - passed ? 1 : 0);
})();
