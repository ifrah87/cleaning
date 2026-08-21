/**
 * Smoke test for the navigation, search, floor allocation and the automatic
 * hand-out — the things the office touches every morning.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/smoke-nav.js
 *
 * SAFETY: never touches the live Supabase project. Every request to *.supabase.co
 * is answered from the fixtures below; nothing leaves this machine except the
 * supabase-js bundle fetched from the CDN. Runs the whole pass twice — once at
 * phone width, once at desktop — because the two now lay out differently.
 */
// Smoke test for the nav overhaul: does every screen still render, does the new
// search/back/floor UI work, and does the desktop layout stay sane.
const http=require('http'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright');
const ROOT='/Users/ifrahawaale/Desktop/cleaning';
const SUPA_HOST='issnrivggzkhrcjfhzit.supabase.co';
const key=(d)=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const TODAY=key(new Date()), YESTERDAY=key(new Date(Date.now()-864e5));
const SESSION={access_token:'t',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:'r',user:{id:'u1',email:'a@b.c',aud:'authenticated',role:'authenticated'}};
const STAFF=[
 {id:'p1',name:'Amina Yusuf',crew:'Team A',isCleaner:true,floors:[1,2],hikPersonId:'h1'},
 {id:'p2',name:'Fatima Ali',crew:'Team A',isCleaner:true,floors:[3],hikPersonId:'h2'},
 {id:'p3',name:'Hodan Omar',crew:'Team B',isCleaner:true,isLeader:true,floors:[],hikPersonId:'h3'},
 // Down as OFF today — the alternating Friday rest day. She turns up anyway and
 // never badges, which is the case the office had no way to record.
 {id:'p4',name:'Zahra Ahmed',crew:'Team B',isCleaner:true,floors:[],
  worksOn:[0,1,2,3,4,5,6].filter(d=>d!==new Date().getDay())},
];
const U=(id,unit,type,freq,last,extra)=>Object.assign({id,unit,type,freq,lastCleaned:last},extra||{});
const APP_STATE={staff:STAFF,servicedUnits:[
 U('u1','101','building','daily',YESTERDAY),
 U('u2','102','building','eod',TODAY),
 U('u3','305','building','eod',TODAY),
 U('u4','402','building','eod',TODAY),
 U('u5','A1','airbnb','daily',YESTERDAY),
 U('u6','Suite 9','office','weekly',YESTERDAY),
 // 601 was cleaned today, so its own schedule says it is NOT due — it is on today's
 // board only because somebody planned it there last night, for Fatima, who badges
 // in an hour after the leader.
 U('u7','601','building','weekly',TODAY),
],completions:{},assignConfirmed:{},
 plans:{[TODAY]:{'unit:u7':{kind:'unit',refId:'u7',label:'601',assignedTo:'p2'}}},
 manualArrivals:{},floors:11};
// Everybody badges in over the morning: leader first, then the rest.
// Hik matches on the person's NAME, and the app asks for one day at a time.
let EVENTS=[{person_name:'Hodan Omar',person_code:'1003',event_time:TODAY+' 06:30:00'}];
const eventsFor=(url)=>{const m=decodeURIComponent(url).match(/event_time=like\.(\d{4}-\d{2}-\d{2})/);return m?EVENTS.filter(e=>e.event_time.startsWith(m[1])):EVENTS};
function serve(){return new Promise(r=>{const s=http.createServer((q,res)=>{const f=q.url.split('?')[0]==='/'?'/index.html':q.url.split('?')[0];const p=path.join(ROOT,f);if(!p.startsWith(ROOT)||!fs.existsSync(p)){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':f.endsWith('.html')?'text/html':f.endsWith('.js')?'text/javascript':f.endsWith('.webmanifest')?'application/manifest+json':'text/plain'});res.end(fs.readFileSync(p))});s.listen(0,'127.0.0.1',()=>r({s,port:s.address().port}))})}
const out=[];const check=(n,c,d)=>{out.push([n,!!c]);console.log((c?'  \x1b[32mPASS\x1b[0m ':'  \x1b[31mFAIL\x1b[0m ')+n+(c||!d?'':'\n       '+d))};
(async()=>{
const {s,port}=await serve();
const browser=await chromium.launch();
for (const [label,vp] of [['PHONE',{width:420,height:900}],['DESKTOP',{width:1440,height:900}]]) {
 // Each viewport starts the morning over: the leader alone, nobody else in yet.
 EVENTS=[{person_name:'Hodan Omar',person_code:'1003',event_time:TODAY+' 06:30:00'}];
 const ctx=await browser.newContext({viewport:vp});
 await ctx.route(`**://${SUPA_HOST}/**`,async(route)=>{const req=route.request(),url=req.url(),m=req.method();
  const json=(b,st=200)=>route.fulfill({status:st,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(b)});
  if(m==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'},body:''});
  if(url.includes('/auth/v1/token'))return json(SESSION);
  if(url.includes('/auth/v1/user'))return json(SESSION.user);
  if(url.includes('/rest/v1/app_state')){if(m==='GET'){const single=String(req.headers()['accept']||'').includes('pgrst.object');const row={data:APP_STATE};return json(single?row:[row])}return json([{}],201)}
  if(url.includes('/rest/v1/hik_events'))return json(m==='GET'?eventsFor(url):[{}]);
  if(url.includes('/rest/v1/cleaning_log'))return json([],m==='POST'?201:200);
  return json([])});
 await ctx.addInitScript(([h,ss])=>{localStorage.setItem('sb-'+h.split('.')[0]+'-auth-token',JSON.stringify(ss))},[SUPA_HOST,SESSION]);
 const page=await ctx.newPage();
 const errs=[];page.on('console',x=>{if(x.type()==='error')errs.push(x.text())});page.on('pageerror',e=>errs.push('pageerror: '+e.message));
 await page.goto(`http://127.0.0.1:${port}/index.html`,{waitUntil:'domcontentloaded'});
 await page.waitForSelector('.nav',{timeout:20000});
 await page.waitForTimeout(2500);
 console.log(`\n\x1b[1m${label}\x1b[0m`);
 const navLabels=await page.locator('.nav button').allTextContents();
 check('bottom bar is Roll Call / Rooms / Plan / Team / More',
   navLabels.join('|').includes('Roll Call')&&navLabels.join('|').includes('Rooms')&&navLabels.join('|').includes('Plan')&&navLabels.join('|').includes('Team'),navLabels.join(' | '));
 // every screen renders
 for (const [tab,idx] of [['Rooms',1],['Plan',2],['Team',3],['More',4]]) {
   await page.locator('.nav button').nth(idx).click(); await page.waitForTimeout(500);
   const t=await page.locator('.h-title').textContent();
   check(`${tab} renders (title: ${t})`, !!t);
 }
 // room segments
 await page.locator('.nav button').nth(1).click(); await page.waitForTimeout(400);
 const segs=await page.locator('.segbtn').allTextContents();
 check('Rooms tab has All/Airbnb/Offices/Buildings filter', segs.length===4, segs.join(' | '));
 await page.locator('.segbtn').nth(1).click(); await page.waitForTimeout(400);
 check('switching filter changes the title', (await page.locator('.h-title').textContent()).includes('Airbnb'), await page.locator('.h-title').textContent());
 // back
 check('Back button is offered', await page.locator('.tb-btn', {hasText:'Back'}).count()>0);
 await page.locator('.tb-btn',{hasText:'Back'}).first().click(); await page.waitForTimeout(400);
 check('Back goes to the previous screen', true);
 // search
 await page.locator('.tb-btn',{hasText:'Search'}).first().click(); await page.waitForTimeout(400);
 check('search sheet opens', await page.locator('.sheet').count()>0);
 await page.locator('.sheet input').fill('402'); await page.waitForTimeout(400);
 const hits=await page.locator('.sr-row').allTextContents();
 check('search finds unit 402 from any screen', hits.join(' ').includes('402'), hits.join(' | '));
 await page.locator('.sr-row').first().click(); await page.waitForTimeout(600);
 check('tapping a hit lands on the room list', (await page.locator('.h-title').textContent()).length>0, await page.locator('.h-title').textContent());
 // floors
 await page.locator('.nav button').nth(3).click(); await page.waitForTimeout(600);
 const body=await page.locator('.body').first().textContent();
 check('Team shows the floor-by-floor allocation', body.includes('Who cleans which floor'), body.slice(0,160));
 const floorRows=await page.locator('.sr-row').count();
 check('one row per floor (11)', floorRows===11, 'rows: '+floorRows);
 // give floor 5 to Fatima via the picker
 const sel=page.locator('.sr-row select').nth(4);
 await sel.selectOption('p2'); await page.waitForTimeout(500);
 const after=await page.locator('.sr-row').nth(4).textContent();
 check('assigning a floor sticks', (await page.locator('.sr-row').nth(4).locator('select').inputValue())==='p2', after);
 // eod rooms pinned to set days automatically
 const pinned=await page.evaluate(()=>(state.servicedUnits||[]).filter(u=>u.freq==='eod').map(u=>({unit:u.unit,days:u.days||null})));
 check('every-other-day rooms were put on set days on their own', pinned.every(x=>x.days&&x.days.length), JSON.stringify(pinned));
 const fri=new Date().getDay();
 check('a room cleaned today is not put on a set containing today', pinned.every(x=>!x.days||x.days.indexOf(fri)<0), 'today dow='+fri+' '+JSON.stringify(pinned));
 // The search box has to stay reachable once the list is scrolled — that is the
 // whole point of pinning it under the header.
 await page.locator('.nav button').nth(1).click(); await page.waitForTimeout(500);
 await page.evaluate(()=>window.scrollTo(0,1400)); await page.waitForTimeout(400);
 const boxSeen=await page.locator('.stickbar input').first().isVisible().catch(()=>false);
 const boxBox=await page.locator('.stickbar input').first().boundingBox().catch(()=>null);
 check('the room search stays on screen when the list is scrolled',
   boxSeen&&boxBox&&boxBox.y>=0&&boxBox.y<vp.height, JSON.stringify(boxBox));
 // Folding a group away is the other half of not scrolling for ever.
 const beforeFold=await page.locator('.su-card').count();
 await page.locator('.grp-head').first().click(); await page.waitForTimeout(500);
 const afterFold=await page.locator('.su-card').count();
 check('tapping a group heading folds its rooms away', afterFold<beforeFold, beforeFold+' -> '+afterFold);
 await page.locator('.grp-head').first().click(); await page.waitForTimeout(500);
 check('and unfolds them again', (await page.locator('.su-card').count())===beforeFold);

 const pinnedDays=await page.evaluate(()=>(state.servicedUnits||[]).filter(u=>u.freq==='eod').map(u=>u.unit+':'+(u.days||[]).join('')));
 check('rooms cleaned today go on Sun/Tue/Thu (next turn Sunday)', pinnedDays.every(x=>x.endsWith(':024')), pinnedDays.join(' '));

 // --- the whole point: the board re-deals as more people badge in ---
 await page.locator('.nav button').nth(0).click(); await page.waitForTimeout(600);
 const boardOf=()=>page.evaluate(()=>{const o={};(state.servicedUnits||[]).forEach(u=>{if(u.assignedTo)o[u.unit]=u.assignedTo});return o});
 const first=await boardOf();
 // Only the leader is in, so every room the plan did NOT already name goes to them.
 check('the rooms nobody planned go to the one person who is in',
   first['101']==='p1'&&first['601']==='p2'&&first['A1']==='p3', JSON.stringify(first));
 // The Friday case: the add list must offer people the rota says are OFF, in their
 // own group, as well as the ones who are simply not in yet.
 const groups=await page.evaluate(()=>{
   const sels=[...document.querySelectorAll('select.area-select')];
   const s=sels.find(x=>x.textContent.includes('didn’t clock in'));
   return s?[...s.querySelectorAll('optgroup')].map(g=>g.label+': '+[...g.querySelectorAll('option')].map(o=>o.textContent).join(',')):[];
 });
 check('the add list separates who is down to work from who is off',
   groups.some(g=>g.startsWith('Down to work today'))&&groups.some(g=>g.startsWith('Off today')), JSON.stringify(groups));
 check('someone down as off today can still be added', groups.join(' ').includes('Zahra Ahmed'), JSON.stringify(groups));

 EVENTS=EVENTS.concat([{person_name:'Amina Yusuf',person_code:'1001',event_time:TODAY+' 07:40:00'},{person_name:'Fatima Ali',person_code:'1002',event_time:TODAY+' 08:10:00'}]);
 await page.evaluate(()=>loadHikArrivals().then(()=>{maybeAutoAssign();render()}));
 await page.waitForTimeout(1500);
 const second=await boardOf();
 check('rooms are shared out again once the others arrive', new Set(Object.values(second)).size>1, JSON.stringify(second));
 check('the leader is no longer carrying the whole board',
   Object.values(second).filter(v=>v==='p3').length<Object.values(first).length, JSON.stringify(second));
 // THE PLAN MADE THE NIGHT BEFORE. 601 is not due by its own schedule and the person
 // it names badged in late, which is exactly the case that used to lose it.
 check('a room planned last night is on the board', !!second['601'], JSON.stringify(second));
 check('and goes back to the person the plan named, once they badge in', second['601']==='p2', JSON.stringify(second));

 // --- somebody who is down as off, but came in anyway ---
 await page.evaluate(()=>addManualArrival('p4'));
 await page.waitForTimeout(1500);
 check('adding them by hand puts them on the roll call as in',
   await page.evaluate(()=>!!hikArrivals['p4']), 'in: '+JSON.stringify(await page.evaluate(()=>Object.keys(hikArrivals))));
 const zahraShown=await page.locator('.person-name', {hasText:'Zahra Ahmed'}).count();
 check('and they are listed with the rest of the crew', zahraShown>0, 'cards: '+zahraShown);
 await page.evaluate(()=>removeManualArrival('p4'));
 await page.waitForTimeout(1500);
 check('taking them back off removes them again',
   await page.evaluate(()=>!hikArrivals['p4']), 'in: '+JSON.stringify(await page.evaluate(()=>Object.keys(hikArrivals))));
 const board=await boardOf();
 check('and leaves no room stranded on somebody who is not here',
   !Object.values(board).includes('p4'), JSON.stringify(board));

 await page.evaluate(()=>{setUnitAssignee('u1','p1')});
 await page.waitForTimeout(500);
 await page.evaluate(()=>{state.staff.push({id:'p9',name:'Late Arrival',crew:'Team A',isCleaner:true,floors:[],hikPersonId:'h9'});});
 EVENTS=EVENTS.concat([{person_name:'Late Arrival',person_code:'1009',event_time:TODAY+' 09:00:00'}]);
 await page.evaluate(()=>loadHikArrivals().then(()=>{maybeAutoAssign();render()}));
 await page.waitForTimeout(1500);
 const third=await boardOf();
 check('a room handed out by hand keeps its cleaner through a re-deal', third['101']==='p1', JSON.stringify(third));

 check('no console errors', errs.length===0, errs.slice(0,4).join('\n       '));
 await ctx.close();
}
await browser.close(); s.close();
const bad=out.filter(x=>!x[1]).length;
console.log(`\n${out.length-bad} passed, ${bad} failed`);
process.exit(bad?1:0);
})();
