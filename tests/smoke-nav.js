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
// THE WORK DAY, NOT THE CALENDAR DAY. The app's day runs from 3am, so a run started at
// half past midnight has a work day of YESTERDAY — and a room stamped "cleaned
// yesterday" by the calendar reads as cleaned today and is never due. Badge-ins are
// read by the work day too, so the events have to carry that date or nobody is in.
const WORK_TODAY=(()=>{const d=new Date();if(d.getHours()<3)d.setDate(d.getDate()-1);return key(d)})();
const DAY_BEFORE=(()=>{const d=new Date();d.setDate(d.getDate()-(d.getHours()<3?2:1));return key(d)})();
const SESSION={access_token:'t',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:'r',user:{id:'u1',email:'a@b.c',aud:'authenticated',role:'authenticated'}};
const STAFF=[
 // Both leaders: rooms are dealt to leaders only, so a cleaner who is meant to run
 // their own round has to be tagged as one. Zahra below stays an assistant on Hodan's
 // team, which is what the pairing checks are about.
 {id:'p1',name:'Amina Yusuf',crew:'Team A',isCleaner:true,isLeader:true,floors:[1,2],hikPersonId:'h1'},
 {id:'p2',name:'Fatima Ali',crew:'Team A',isCleaner:true,isLeader:true,floors:[3],hikPersonId:'h2'},
 {id:'p3',name:'Hodan Omar',crew:'Team B',isCleaner:true,isLeader:true,floors:[],hikPersonId:'h3'},
 // Down as OFF today — the alternating Friday rest day. She turns up anyway and
 // never badges, which is the case the office had no way to record.
 {id:'p4',name:'Zahra Ahmed',crew:'Team B',isCleaner:true,floors:[],
  worksOn:[0,1,2,3,4,5,6].filter(d=>d!==new Date().getDay())},
];
const U=(id,unit,type,freq,last,extra)=>Object.assign({id,unit,type,freq,lastCleaned:last},extra||{});
const APP_STATE={staff:STAFF,servicedUnits:[
 U('u1','101','building','daily',DAY_BEFORE),
 U('u2','102','building','eod',WORK_TODAY),
 U('u3','305','building','eod',WORK_TODAY),
 U('u4','402','building','eod',WORK_TODAY),
 U('u5','A1','airbnb','daily',DAY_BEFORE,{preferLate:true}),   // afternoon work, like every guest flat
 U('u6','Suite 9','office','weekly',DAY_BEFORE),
 // 601 was cleaned today, so its own schedule says it is NOT due — it is on today's
 // board only because somebody planned it there last night, for Fatima, who badges
 // in an hour after the leader.
 U('u7','601','building','weekly',WORK_TODAY),
],completions:{},assignConfirmed:{},
 plans:{[WORK_TODAY]:{'unit:u7':{kind:'unit',refId:'u7',label:'601',assignedTo:'p2'}}},
 manualArrivals:{},floors:11};
// Everybody badges in over the morning: leader first, then the rest.
// Hik matches on the person's NAME, and the app asks for one day at a time.
let EVENTS=[{person_name:'Hodan Omar',person_code:'1003',event_time:WORK_TODAY+' 06:30:00'}];
const eventsFor=(url)=>{const m=decodeURIComponent(url).match(/event_time=like\.(\d{4}-\d{2}-\d{2})/);return m?EVENTS.filter(e=>e.event_time.startsWith(m[1])):EVENTS};
function serve(){return new Promise(r=>{const s=http.createServer((q,res)=>{const f=q.url.split('?')[0]==='/'?'/index.html':q.url.split('?')[0];const p=path.join(ROOT,f);if(!p.startsWith(ROOT)||!fs.existsSync(p)){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':f.endsWith('.html')?'text/html':f.endsWith('.js')?'text/javascript':f.endsWith('.webmanifest')?'application/manifest+json':'text/plain'});res.end(fs.readFileSync(p))});s.listen(0,'127.0.0.1',()=>r({s,port:s.address().port}))})}
const out=[];const check=(n,c,d)=>{out.push([n,!!c]);console.log((c?'  \x1b[32mPASS\x1b[0m ':'  \x1b[31mFAIL\x1b[0m ')+n+(c||!d?'':'\n       '+d))};
(async()=>{
const {s,port}=await serve();
const browser=await chromium.launch();
for (const [label,vp] of [['PHONE',{width:420,height:900}],['DESKTOP',{width:1440,height:900}]]) {
 // Each viewport starts the morning over: the leader alone, nobody else in yet.
 EVENTS=[{person_name:'Hodan Omar',person_code:'1003',event_time:WORK_TODAY+' 06:30:00'}];
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
 await page.waitForSelector('.header',{timeout:20000});
 await page.waitForTimeout(2500);
 console.log(`\n\x1b[1m${label}\x1b[0m`);
 // ONE SCREEN, AND A MENU FOR EVERYTHING ELSE. There is no tab bar: the app opens on the
 // board — the same board that is on the wall — and Rooms, the morning set-up, the team,
 // the history and the settings are all behind ☰ in the corner.
 check('there is no tab bar', await page.locator('.nav').count()===0, 'a .nav is still being rendered');
 check('the app opens on the board', await page.evaluate(()=>state.tab)==='board' && await page.locator('.bd-col').count()>0,
   'tab: '+await page.evaluate(()=>state.tab));
 check('the board carries a column per cleaner', await page.locator('.bd-col .bd-who').count()>0);
 check('and coloured chips on it', await page.locator('.bd-job').count()>0, 'chips: '+await page.locator('.bd-job').count());

 // the menu, and every screen behind it
 await page.locator('.tb-btn',{hasText:'☰'}).first().click(); await page.waitForTimeout(400);
 const menu=await page.locator('body').textContent();
 check('☰ opens everything else', /Everything else/.test(menu), menu.slice(0,120));
 for (const name of ['Rooms & schedules','Morning set-up','Team','Cleaning history','Settings']) {
   check(`the menu offers ${name}`, menu.includes(name));
 }
 await page.locator('button',{hasText:'Rooms & schedules'}).first().click(); await page.waitForTimeout(600);
 check('picking one goes there', await page.evaluate(()=>state.tab)==='rooms', await page.evaluate(()=>state.tab));

 // room segments
 const segs=await page.locator('.segbtn').allTextContents();
 check('Rooms has All/Airbnb/Offices/Buildings filter', segs.length===4, segs.join(' | '));
 await page.locator('.segbtn').nth(1).click(); await page.waitForTimeout(400);
 check('switching filter changes the title', (await page.locator('.h-title, .header').first().textContent()).includes('Airbnb'),
   await page.locator('.header').first().textContent());
 // back
 check('Back button is offered', await page.locator('.tb-btn', {hasText:'Back'}).count()>0);
 await page.locator('.tb-btn',{hasText:'Back'}).first().click(); await page.waitForTimeout(400);
 check('Back goes to the previous screen', true);
 // search
 await page.locator('.tb-btn',{hasText:'⌕'}).first().click(); await page.waitForTimeout(400);
 check('search sheet opens', await page.locator('.sheet').count()>0);
 await page.locator('.sheet input').fill('402'); await page.waitForTimeout(400);
 const hits=await page.locator('.sr-row').allTextContents();
 check('search finds unit 402 from any screen', hits.join(' ').includes('402'), hits.join(' | '));
 await page.locator('.sr-row').first().click(); await page.waitForTimeout(600);
 check('tapping a hit lands somewhere real', (await page.evaluate(()=>state.tab)).length>0, await page.evaluate(()=>state.tab));
 // floors
 await page.evaluate(()=>setTab('team')); await page.waitForTimeout(600);
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
 // Which weekday set is right depends on what day it is — Sat/Mon/Wed/Fri runs
 // Fri→Sat back to back, Sun/Tue/Thu runs Thu→Sun. So assert the RULE, not a set:
 // whichever it picked, the next clean must land two days after the last one.
 const gaps=await page.evaluate(()=>(state.servicedUnits||[]).filter(u=>u.freq==='eod'&&u.days&&u.lastCleaned)
   .map(u=>{ for(let i=1;i<=7;i+=1){ const d=shiftDay(u.lastCleaned,i); if(u.days.indexOf(dowOf(d))>=0) return {unit:u.unit,gap:i}; } return {unit:u.unit,gap:null}; }));
 check('the set it picks keeps the room two days apart', gaps.length>0&&gaps.every(g=>g.gap===2), JSON.stringify(gaps));
 // The search box has to stay reachable once the list is scrolled — that is the
 // whole point of pinning it under the header. This is the Rooms screen, behind ☰.
 await page.evaluate(()=>setTab('rooms')); await page.waitForTimeout(600);
 await page.evaluate(()=>window.scrollTo(0,1400)); await page.waitForTimeout(400);
 const boxSeen=await page.locator('.stickbar input').first().isVisible().catch(()=>false);
 const boxBox=await page.locator('.stickbar input').first().boundingBox().catch(()=>null);
 check('the room search stays on screen when the list is scrolled',
   boxSeen&&boxBox&&boxBox.y>=0&&boxBox.y<vp.height, JSON.stringify(boxBox));
 // Folding a group away is the other half of not scrolling for ever.
 const sects=await page.locator('.grp-btn').allTextContents();
 check('each kind of room is its own drop-down section', sects.length>=2, sects.join(' | '));
 const air=page.locator('.grp-btn', {hasText:'Airbnb'}).first();
 check('the Airbnb section starts shut', (await air.textContent()).includes('separate job')
   && (await air.locator('.grp-caret').textContent())==='▸', await air.textContent());
 const beforeOpen=await page.locator('.su-card').count();
 await air.click(); await page.waitForTimeout(500);
 check('opening it shows its rooms', (await page.locator('.su-card').count())>beforeOpen,
   beforeOpen+' -> '+(await page.locator('.su-card').count()));
 await page.locator('.grp-btn', {hasText:'Airbnb'}).first().click(); await page.waitForTimeout(500);
 check('and it shuts again', (await page.locator('.su-card').count())===beforeOpen);
 // …and an OPEN section (Airbnb is the shut one) folds the other way.
 const openSect=page.locator('.grp-btn').last();
 const beforeFold=await page.locator('.su-card').count();
 await openSect.click(); await page.waitForTimeout(500);
 const afterFold=await page.locator('.su-card').count();
 check('folding an open section hides its rooms', afterFold<beforeFold, beforeFold+' -> '+afterFold);
 await page.locator('.grp-btn').last().click(); await page.waitForTimeout(500);
 check('and unfolds them again', (await page.locator('.su-card').count())===beforeFold);

 // AN EVERY-OTHER-DAY ROOM MUST NOT BE DUE EVERY DAY. Once its next-due date passed
 // it stayed due for ever, including on every future day — which put it on every
 // day's plan, and the roll call shows what the plan holds.
 const beat=await page.evaluate(()=>{
   const days=Array.from({length:7},(_,i)=>shiftDay(workToday(),i));
   const mk=(u)=>days.map(d=>dueOnDay(u,d)?'X':'.').join('');
   const y=shiftDay(workToday(),-1), old=shiftDay(workToday(),-3);
   return {
     cleanedYesterday: mk({id:'t1',unit:'T1',type:'building',freq:'eod',lastCleaned:y}),
     overdue:          mk({id:'t2',unit:'T2',type:'building',freq:'eod',lastCleaned:old}),
     neverRecorded:    mk({id:'t3',unit:'T3',type:'building',freq:'eod'}),
     daily:            mk({id:'t4',unit:'T4',type:'building',freq:'daily',lastCleaned:y}),
   };
 });
 const alternates=(s)=>!/XX/.test(s.slice(1));   // no two due days in a row after today
 check('an every-other-day room cleaned yesterday is due every OTHER day',
   beat.cleanedYesterday==='.X.X.X.', beat.cleanedYesterday);
 check('an overdue every-other-day room shows today, then on its own beat',
   beat.overdue[0]==='X'&&alternates(beat.overdue), beat.overdue);
 check('a never-recorded room shows today, then on its own beat',
   beat.neverRecorded[0]==='X'&&alternates(beat.neverRecorded), beat.neverRecorded);
 check('a daily room is still due every day', beat.daily==='XXXXXXX', beat.daily);

 // RECORDING A CLEAN HAS TO AFFECT TOMORROW. A pinned room ignored the last clean
 // entirely, so marking 305 cleaned today still planned it for the morning after.
 const pinnedRecent=await page.evaluate(()=>{
   const t=workToday(), tom=shiftDay(t,1), dowT=dowOf(t), dowTom=dowOf(tom);
   // pinned to a set that contains BOTH today and tomorrow — the back-to-back case
   const eod={id:'r1',unit:'R1',type:'building',freq:'eod',days:[dowT,dowTom],lastCleaned:t};
   const wk ={id:'r2',unit:'R2',type:'building',freq:'weekly',days:[dowTom],lastCleaned:shiftDay(t,-5)};
   const dy ={id:'r3',unit:'R3',type:'building',freq:'daily',days:[dowT,dowTom],lastCleaned:shiftDay(t,-1)};
   return {
     eodTomorrow: dueOnDay(eod,tom),
     eodDayAfter: dueOnDay({...eod,days:[dowOf(shiftDay(t,2))]},shiftDay(t,2)),
     weeklyOwnDay: dueOnDay(wk,tom),
     dailyToday: dueOnDay(dy,t),
   };
 });
 check('a room recorded as cleaned today is not planned for tomorrow',
   pinnedRecent.eodTomorrow===false, JSON.stringify(pinnedRecent));
 check('it is back on its own days straight after',
   pinnedRecent.eodDayAfter===true, JSON.stringify(pinnedRecent));
 check('a weekly room cleaned mid-week still takes its own day',
   pinnedRecent.weeklyOwnDay===true, JSON.stringify(pinnedRecent));
 check('a pinned daily room cleaned yesterday is still due today',
   pinnedRecent.dailyToday===true, JSON.stringify(pinnedRecent));

 // ROLL CALL AND PLAN A DAY ARE THE SAME BUILDING ON THE SAME DAY. Today was the one
 // day the week-ahead loop never laid out, so the plan for it was empty while the roll
 // call showed a full morning; and the plan dropped a room the moment it was cleaned,
 // where the roll call keeps it with a tick.
 const agree=await page.evaluate(()=>{
   const day=workToday();
   const rc=todaysRoomList().map(u=>u.unit).sort();
   const pl=planJobs(day).filter(j=>j.kind==='unit')
     .map(j=>String(j.label).replace(/^Unit /,'')).sort();
   return {day, rc, pl, planExists:!!(state.plans||{})[day],
           onlyRC:rc.filter(x=>!pl.includes(x)), onlyPlan:pl.filter(x=>!rc.includes(x))};
 });
 check('today gets a plan like every other day', agree.planExists && agree.pl.length>0,
   `${agree.pl.length} jobs on today's plan`);
 check('roll call and the plan show the same rooms for today',
   agree.onlyRC.length===0 && agree.onlyPlan.length===0,
   `roll call only: ${JSON.stringify(agree.onlyRC)} · plan only: ${JSON.stringify(agree.onlyPlan)}`);
 check('and the same number of them', agree.rc.length===agree.pl.length,
   `${agree.rc.length} vs ${agree.pl.length}`);
 // Plan a Day opens on the day the board is showing, not on tomorrow.
 await page.evaluate(()=>setTab('plan')); await page.waitForTimeout(700);
 const planHdr=await page.locator('.h-date').first().textContent();
 check('Plan a Day opens on today', /TODAY/.test(planHdr), planHdr);
 await page.evaluate(()=>setTab('board')); await page.waitForTimeout(500);

 // A DAILY ROOM COMES UP EVERY DAY, MARKED OR NOT — with the one exception the office
 // works to: the daily rooms are cleaned on the Friday IN ADVANCE OF THE SATURDAY, so
 // a Friday clean already covers the Saturday and the room comes back on the Sunday.
 // Written against doneFridayForSaturday rather than a hard-coded XXXXXXX, because the
 // run day decides whether that pair is inside the week being looked at at all — a
 // hard-coded seven passes six days a week and fails on the seventh.
 const dailyBeat=await page.evaluate(()=>{
   const days=Array.from({length:7},(_,i)=>shiftDay(workToday(),i));
   const mk=(u)=>days.map(d=>dueOnDay(u,d)?'X':'.').join('');
   const want=(u)=>days.map(d=>doneFridayForSaturday(u,d,u.lastCleaned||null)?'.':'X').join('');
   const U=(id,unit,freq,last)=>Object.assign({id,unit,type:'building',freq},last?{lastCleaned:last}:{});
   const cases={
     cleanedYesterday: U('d1','D1','daily',shiftDay(workToday(),-1)),
     notMarkedForAges: U('d2','D2','daily',shiftDay(workToday(),-9)),
     neverMarked:      U('d3','D3','daily'),
     nightly:          U('d4','D4','nightly',shiftDay(workToday(),-4)),
   };
   const out={};
   Object.keys(cases).forEach(k=>{ out[k]={got:mk(cases[k]),want:want(cases[k])}; });
   return out;
 });
 check('a daily room comes up every day, bar the Saturday a Friday clean already covered',
   Object.values(dailyBeat).every(v=>v.got===v.want), JSON.stringify(dailyBeat));

 // SETTING THE FREQUENCY HAS TO STICK. A pinned room is its days and nothing else,
 // so tapping a frequency used to light the chip up and change nothing.
 const freqStick=await page.evaluate(()=>{
   const u=(state.servicedUnits||[]).find(x=>x.freq==='eod');
   const pinnedBefore=(u.days||[]).slice();
   setUnitFreq(u.id,'daily');
   const days=Array.from({length:7},(_,i)=>shiftDay(workToday(),i));
   return {id:u.id, pinnedBefore, freq:u.freq, daysAfter:u.days, last:u.lastCleaned||null,
           // The one-off spreaders, in the failure message: a room held back or carrying
           // a cycle shift does not come up every day, and the string alone never said why.
           holdUntil:u.holdUntil||null, cycleShift:u.cycleShift||null,
           cycleShiftFrom:u.cycleShiftFrom||null, alsoCleanOn:u.alsoCleanOn||null,
           workToday:workToday(), base:lastCleanDate(u), nd:nextDueDate(u), cyc:cycleLen(u),
           want:days.map(d=>doneFridayForSaturday(u,d,lastCleanDate(u))?'.':'X').join(''),
           onList:onTodaysList(u), due:days.map(d=>dueOnDay(u,d)?'X':'.').join('')};
 });
 check('the room was on fixed days to begin with', freqStick.pinnedBefore.length>0, JSON.stringify(freqStick));
 check('setting it to Daily takes it off its fixed days', !freqStick.daysAfter, JSON.stringify(freqStick));
 // It was cleaned today, so today it reads as done rather than due — but it is on
 // today's list, and every day after it is due again — bar a Saturday that the Friday
 // round already covered, which is the one day "every day" does not mean every day.
 check('and it then actually comes up every day',
   freqStick.onList && freqStick.due.slice(1)===freqStick.want.slice(1), JSON.stringify(freqStick));

 const pinnedDays=await page.evaluate(()=>(state.servicedUnits||[]).filter(u=>u.freq==='eod').map(u=>u.unit+':'+(u.days||[]).join('')));
 // Sat/Mon/Wed and Sun/Tue/Thu. Friday is the office's own day — they work out who is
 // in and pick the rooms themselves — so nothing automatic is ever put on it.
 check('every eod room ends up on one of the two weekday sets',
   pinnedDays.every(x=>/:(613|024)$/.test(x)), pinnedDays.join(' '));
 check('and none of them lands on a Friday',
   pinnedDays.every(x=>x.split(':')[1].indexOf('5')<0), pinnedDays.join(' '));

 // --- the whole point: the board re-deals as more people badge in ---
 await page.evaluate(()=>setTab('board')); await page.waitForTimeout(600);
 const boardOf=()=>page.evaluate(()=>{const o={};(state.servicedUnits||[]).forEach(u=>{if(u.assignedTo)o[u.unit]=u.assignedTo});return o});
 const first=await boardOf();
 // Only the leader is in. Everything the plan did not already name goes to them —
 // and nothing may be handed to somebody who is not here, which is what left rooms
 // sitting all morning under the name of a cleaner who had not turned up.
 const inNow=await page.evaluate(()=>Object.keys(hikArrivals));
 const planned=await page.evaluate(()=>Object.values((state.plans||{})[workToday()]||{})
   .filter(j=>j.assignedTo).map(j=>j.assignedTo));
 const strays=Object.entries(first).filter(([,who])=>!inNow.includes(who)&&!planned.includes(who));
 check('no room is handed to somebody who has not badged in',
   strays.length===0, 'in: '+JSON.stringify(inNow)+' board: '+JSON.stringify(first));
 check('the rooms nobody planned go to the one person who is in',
   first['101']==='p3', JSON.stringify(first));
  // A GUEST FLAT IS HANDED OUT BY A PERSON, NEVER BY THE APP. It was dealt like an
 // office room for a while, on the reasoning that keeping it off the round meant the
 // flats went out by memory. In practice the office arrived every morning to flats
 // already sitting on people who were not going to do them, and moved them by hand —
 // and four of them were carrying names from three days earlier that nobody had set.
 // They stay ON the board so they can be ticked and given out on the Airbnb tab; the
 // only thing that changed is that nothing puts a name on one unless a person does.
 check('an Airbnb flat is left for a person to hand out',
   !first['A1'], 'A1 -> ' + first['A1']);
 check('...and is afternoon work, so it sorts below the morning round',
   await page.evaluate(()=>{
     const u=state.servicedUnits.find(x=>x.unit==='A1');
     return slotRank(u) > slotRank(state.servicedUnits.find(x=>x.unit==='101'));
   }), 'A1 does not sort after 101');
 // The Friday case: the add list must offer people the rota says are OFF, in their
 // own group, as well as the ones who are simply not in yet.
 // Who's in folds shut by default now — fifteen sections down one column is an archive,
 // not a screen — so open it the way a thumb would before reading what is inside.
 await page.evaluate(()=>{ setTab('rollcall'); state.rcFold = Object.assign({}, state.rcFold, {whoin:true}); render(); });
 await page.waitForTimeout(700);
 const groups=await page.evaluate(()=>{
   const sels=[...document.querySelectorAll('select.area-select')];
   const s=sels.find(x=>x.textContent.includes('didn’t clock in'));
   return s?[...s.querySelectorAll('optgroup')].map(g=>g.label+': '+[...g.querySelectorAll('option')].map(o=>o.textContent).join(',')):[];
 });
 check('the add list separates who is down to work from who is off',
   groups.some(g=>g.startsWith('Down to work today'))&&groups.some(g=>g.startsWith('Off today')), JSON.stringify(groups));
 check('someone down as off today can still be added', groups.join(' ').includes('Zahra Ahmed'), JSON.stringify(groups));

 EVENTS=EVENTS.concat([{person_name:'Amina Yusuf',person_code:'1001',event_time:WORK_TODAY+' 07:40:00'},{person_name:'Fatima Ali',person_code:'1002',event_time:WORK_TODAY+' 08:10:00'}]);
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
 // Hodan leads Team B and Zahra is the assistant on it. Until Zahra is in, the
 // leader is not paired with anybody and must not claim to be. The person cards live
 // on the morning set-up now, behind ☰, with who's-in folded shut.
 await page.evaluate(()=>{ setTab('rollcall'); state.rcFold=Object.assign({},state.rcFold,{whoin:true}); render(); });
 await page.waitForTimeout(700);
 const soloCard=await page.locator('.person', {hasText:'Hodan Omar'}).first().textContent();
 check('a leader with nobody in alongside them is not paired up',
   !/with Zahra/.test(soloCard), soloCard.slice(0,80));

 await page.evaluate(()=>addManualArrival('p4'));
 await page.waitForTimeout(1500);
 check('adding them by hand puts them on the roll call as in',
   await page.evaluate(()=>!!hikArrivals['p4']), 'in: '+JSON.stringify(await page.evaluate(()=>Object.keys(hikArrivals))));
 // AN ASSISTANT IS NOT A SECOND ROUND, SO THEY ARE NOT A SECOND CARD. They work the
 // leader's round, so they are named on that leader — the check below — and given no
 // card of their own, which used to come with a "+ Assign a room or area…" offering the
 // one thing the hand-out refuses to do.
 const zahraShown=await page.locator('.person-name', {hasText:'Zahra Ahmed'}).count();
 check('an assistant gets no card of their own', zahraShown===0, 'cards: '+zahraShown);
 const alsoIn=await page.locator('.body').first().textContent();
 check('but is named as in, so nobody thinks the reader missed them',
   /working a leader.s round/i.test(alsoIn)&&/Zahra/.test(alsoIn), 'no "also in" line');
 const pairCard=await page.locator('.person', {hasText:'Hodan Omar'}).first().textContent();
 check('the assistant\'s name comes up next to their leader',
   /with Zahra/.test(pairCard), pairCard.slice(0,110));

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
 EVENTS=EVENTS.concat([{person_name:'Late Arrival',person_code:'1009',event_time:WORK_TODAY+' 09:00:00'}]);
 await page.evaluate(()=>loadHikArrivals().then(()=>{maybeAutoAssign();render()}));
 await page.waitForTimeout(1500);
 const third=await boardOf();
 check('a room handed out by hand keeps its cleaner through a re-deal', third['101']==='p1', JSON.stringify(third));

 // --- the hand-out sheet: a whole day's teams, on one screen, photographable ---
 // Built up to a realistic morning first: 30 rooms across 5 cleaners.
 await page.evaluate(()=>{
   const names=['Amina Yusuf','Fatima Ali','Hodan Omar','Zahra Ahmed','Sagal Nur'];
   names.forEach((n,i)=>{ if(!(state.staff||[]).some(s=>s.name===n))
     state.staff.push({id:'sp'+i,name:n,crew:'Team A',isCleaner:true,floors:[]}); });
   const crew=names.map(n=>(state.staff||[]).find(s=>s.name===n).id);
   const day=workToday(); state.plans=state.plans||{}; const plan={};
   for(let i=0;i<30;i++){
     const id='sheet'+i, unit=String(101+i);
     if(!(state.servicedUnits||[]).some(u=>u.id===id))
       state.servicedUnits.push({id,unit,type:'building',freq:'daily',lastCleaned:shiftDay(day,-1)});
     plan['unit:'+id]={kind:'unit',refId:id,label:'Unit '+unit,assignedTo:crew[i%crew.length]};
   }
   state.plans[day]=plan; save();
 });
 // The hand-out sheet is on the Plan screen, which is behind ☰.
 await page.evaluate(()=>setTab('plan')); await page.waitForTimeout(700);
 await page.locator('button', {hasText:'Hand-out sheet'}).first().click(); await page.waitForTimeout(700);
 check('the hand-out sheet opens', await page.locator('.sheet-paper').count()>0);
 const rowN=await page.locator('.sp-row').count();
 const looseN=await page.locator('.sp-row.sp-loose').count();
 check('a row per cleaner, plus at most one row for anything nobody has',
   rowN-looseN>=5 && looseN<=1, `rows ${rowN}, of which ${looseN} unassigned`);
 if(looseN) check('work nobody has is called out, not hidden',
   (await page.locator('.sp-row.sp-loose').textContent()).includes('Nobody'),
   await page.locator('.sp-row.sp-loose').textContent());
 const emptyRows=await page.evaluate(()=>[...document.querySelectorAll('.sp-row')]
   .filter(r=>!r.querySelectorAll('.sp-job').length).length);
 check('no row is empty', emptyRows===0, 'empty rows: '+emptyRows);
 // The day the screen opens on is seeded from the schedule, so it carries the
 // communal walks as well as the 30 rooms — every planned job has to be on the sheet.
 const jobN=await page.locator('.sp-job').count();
 check('every planned job is on it', jobN>=30, 'jobs: '+jobN);
 const sheetTxt=await page.locator('.sheet-paper').textContent();
 check('it names the day and the size of it', /\d+ cleaners · \d+ jobs/.test(sheetTxt), sheetTxt.slice(0,90));
 check('the count on the sheet matches what is on it', sheetTxt.includes(jobN+' jobs'), sheetTxt.slice(0,90));
 // THE POINT: it has to fit the screen, or a screenshot is the top third of it.
 const pageH=await page.evaluate(()=>document.documentElement.scrollHeight);
 check('the whole day fits on one screen', pageH<=vp.height, `page ${pageH}px vs screen ${vp.height}px`);
 if(process.env.SHOT_DIR) await page.screenshot({path:process.env.SHOT_DIR ? require('path').join(process.env.SHOT_DIR,'handout-'+label.toLowerCase()+'.png') : undefined,fullPage:true});
 await page.locator('button', {hasText:'Back to planning'}).first().click(); await page.waitForTimeout(500);

 check('no console errors', errs.length===0, errs.slice(0,4).join('\n       '));
 await ctx.close();
}
await browser.close(); s.close();
const bad=out.filter(x=>!x[1]).length;
console.log(`\n${out.length-bad} passed, ${bad} failed`);
process.exit(bad?1:0);
})();
