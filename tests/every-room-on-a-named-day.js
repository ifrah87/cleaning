/**
 * EVERY ROOM, ON A DAY THE OFFICE NAMES. Fridays nothing is due — the offices are shut
 * and every room is pinned to other days — but some Fridays the office wants the whole
 * building done. ☰ › "Clean every room today" puts every room on the board for that day
 * only; switching it off puts the normal schedule back.
 *
 * Run:  NODE_PATH="$(pwd)/scraper/node_modules" node tests/every-room-on-a-named-day.js
 *
 * SAFETY: never touches the live Supabase project — every request is answered here.
 */
const http=require('http'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright');
const ROOT='/Users/ifrahawaale/Desktop/cleaning';
const SUPA_HOST='issnrivggzkhrcjfhzit.supabase.co';
// A Friday, mid-morning, always.
const NOW_AT=new Date('2026-10-23T09:00:00').getTime();
const FRI='2026-10-23', THU='2026-10-22';
const SESSION={access_token:'t',token_type:'bearer',expires_in:3600,expires_at:Math.floor(NOW_AT/1000)+3600,refresh_token:'r',user:{id:'u1',email:'a@b.c',aud:'authenticated',role:'authenticated'}};
const STAFF=[{id:'p1',name:'Amina Yusuf',crew:'Team A',isCleaner:true,isLeader:true,floors:[1,2,3],hikPersonId:'h1'}];
// Every room was done in Thursday's sweep and none of them is down for a Friday.
const U=(id,unit,type,days)=>({id,unit,type,freq:'daily',days,daysAuto:false,lastCleaned:THU});
const APP_STATE={staff:STAFF,servicedUnits:[
 U('u1','101','building',[6,1,3,4]), U('u2','102','building',[6,0,2,4]),
 U('u3','305','building',[6,1,3,4]), U('u4','Suite 9','office',[6]), U('u5','A1','airbnb',[6,0,1,2,3,4]),
],completions:{},assignConfirmed:{},plans:{},manualArrivals:{},floors:11};
function serve(){return new Promise(r=>{const s=http.createServer((q,res)=>{const f=q.url.split('?')[0]==='/'?'/index.html':q.url.split('?')[0];const p=path.join(ROOT,f);if(!p.startsWith(ROOT)||!fs.existsSync(p)){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':f.endsWith('.html')?'text/html':f.endsWith('.js')?'text/javascript':'text/plain'});res.end(fs.readFileSync(p))});s.listen(0,'127.0.0.1',()=>r({s,port:s.address().port}))})}
const out=[];const check=(n,c,d)=>{out.push([n,!!c]);console.log((c?'  \x1b[32mPASS\x1b[0m ':'  \x1b[31mFAIL\x1b[0m ')+n+(c||!d?'':'\n       '+d))};
(async()=>{
const {s,port}=await serve();
const browser=await chromium.launch();
const ctx=await browser.newContext({viewport:{width:420,height:900}});
await ctx.addInitScript((at)=>{const Real=Date,off=at-Real.now();
 window.Date=class extends Real{constructor(...a){super(...(a.length?a:[Real.now()+off]))}static now(){return Real.now()+off}};},NOW_AT);
await ctx.route(`**://${SUPA_HOST}/**`,async(route)=>{const req=route.request(),url=req.url(),m=req.method();
 const json=(b,st=200)=>route.fulfill({status:st,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(b)});
 if(m==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'},body:''});
 if(url.includes('/auth/v1/token'))return json(SESSION);
 if(url.includes('/auth/v1/user'))return json(SESSION.user);
 if(url.includes('/rest/v1/app_state')){if(m==='GET'){const single=String(req.headers()['accept']||'').includes('pgrst.object');const row={data:APP_STATE};return json(single?row:[row])}return json([{}],201)}
 if(url.includes('/rest/v1/hik_events'))return json(m==='GET'?[{person_name:'Amina Yusuf',person_code:'1001',event_time:FRI+' 06:30:00'}]:[{}]);
 return json([],m==='POST'?201:200)});
await ctx.addInitScript(([h,ss])=>{localStorage.setItem('sb-'+h.split('.')[0]+'-auth-token',JSON.stringify(ss))},[SUPA_HOST,SESSION]);
const page=await ctx.newPage();
const errs=[];page.on('pageerror',e=>errs.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`,{waitUntil:'domcontentloaded'});
await page.waitForSelector('.header',{timeout:20000});
await page.waitForTimeout(2500);
const dueNow=()=>page.evaluate(()=>state.servicedUnits.filter(u=>dueOnDayFrom(u,workToday(),lastCleanDate(u))).map(u=>u.unit).sort());
const boardText=()=>page.evaluate(()=>document.body.textContent);

check('it is Friday in the app', await page.evaluate(()=>workToday())===FRI);
check('on a normal Friday no room is due', (await dueNow()).length===0, (await dueNow()).join(' '));

await page.locator('.tb-btn',{hasText:'☰'}).first().click(); await page.waitForTimeout(400);
check('the menu offers "Clean every room today"', (await boardText()).includes('Clean every room today'));
await page.locator('button',{hasText:'Clean every room today'}).first().click(); await page.waitForTimeout(800);
const all=await dueNow();
check('switched on, every room is due today', all.length===5, all.join(' '));
const txt=await boardText();
check('and every room is on the board', ['101','102','305','Suite 9','A1'].every(r=>txt.includes(r)), txt.slice(0,300));
check('it is kept for today only, and synced as a setting',
 await page.evaluate((d)=>JSON.stringify(state.allRoomsDays)===JSON.stringify({[d]:true})&&SETTING_KEYS.includes('allRoomsDays'),FRI));
check('tomorrow is untouched by it', await page.evaluate(()=>!allRoomsOn(shiftDay(workToday(),1))));

await page.locator('.tb-btn',{hasText:'☰'}).first().click(); await page.waitForTimeout(400);
check('the menu shows it is on', (await boardText()).includes('Every room is on today'));
await page.locator('button',{hasText:'Every room is on today'}).first().click(); await page.waitForTimeout(800);
check('switched off, the normal Friday is back', (await dueNow()).length===0, (await dueNow()).join(' '));
check('no page errors', errs.length===0, errs.join(' | '));

await browser.close(); s.close();
const f=out.filter(x=>!x[1]).length;console.log(`\n${out.length-f} passed, ${f} failed`);process.exit(f?1:0);
})();
