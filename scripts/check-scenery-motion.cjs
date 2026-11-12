const {spawnSync}=require('node:child_process');
async function suite(page){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const assert=(v,m)=>{if(!v)throw Error(m)};
 await page.addInitScript(()=>window.EventSource=class{addEventListener(){}close(){}});
 await page.route('**/api/state',r=>r.fulfill({json:{instance:'scenery',seq:0,server_time:Date.now()/1000,snapshot:{at:Date.now()/1000,sessions:[],errors:[]},usage:[],events:[],collector_error:false}}));
 await page.goto('http://127.0.0.1:3010/');await page.waitForFunction(()=>typeof data!=='undefined'&&data?.instance==='scenery');
 await page.evaluate(()=>{window.sceneryRows=[];window.driveScenery=()=>{const now=Date.now()/1000;serverClock.observe(now);applyState({...data,server_time:now,snapshot:{at:now,sessions:sceneryRows,errors:[]}})};window.readScenery=()=>Object.fromEntries([...document.querySelectorAll('.workshop-room')].map(r=>[r.dataset.workshopProvider,['.journey-trail','.journey-parallax-hills','.journey-parallax-mountains'].map(s=>new DOMMatrix(getComputedStyle(r.querySelector(s)).transform).m41)]));});
 const read=()=>page.evaluate(()=>readScenery());
 assert(await page.locator('.journey-trail').count()===3,'three independent roads');
 const parked=await read();await page.waitForTimeout(250);assert(JSON.stringify(parked)===JSON.stringify(await read()),'idle stationary');
 await page.evaluate(()=>{sceneryRows=[{provider:'codex',session_id:'c',status:'running'},...Array.from({length:4},(_,i)=>({provider:'claude',session_id:'f'+i,status:'running'})),{provider:'antigravity',session_id:'b',status:'background'}];driveScenery()});
 await page.waitForTimeout(750);const start=await read();await page.waitForTimeout(450);const end=await read();
 const travel=Object.fromEntries(Object.keys(start).map(p=>[p,start[p].map((v,i)=>v-end[p][i])]));
 assert(travel.codex[0]>2&&travel.claude[0]>travel.codex[0]*2&&travel.antigravity[0]<travel.codex[0]*.7,'workload speed tiers');
 for(const p of Object.keys(travel))assert(Math.abs(travel[p][1]/travel[p][0]-.22)<.02,'slower hill '+p);
 for(const p of Object.keys(travel))assert(travel[p][2]>0&&Math.abs(travel[p][2]/travel[p][0]-.06)<.01,'slowest mountain '+p);
 await page.evaluate(()=>{sceneryRows=sceneryRows.filter(r=>r.provider!=='codex');driveScenery()});await page.waitForTimeout(750);const stop=await read();await page.waitForTimeout(250);const afterStop=await read();assert(stop.codex[0]===afterStop.codex[0]&&stop.claude[0]!==afterStop.claude[0],'independent stop');
 for(const status of ['waiting_input','failed','unknown']){
  await page.evaluate(status=>{sceneryRows=[{provider:'codex',session_id:'attention',status}];driveScenery()},status);await page.waitForTimeout(650);const a=await read();await page.waitForTimeout(100);assert(JSON.stringify(a)===JSON.stringify(await read()),'stationary '+status);
 }
 await page.evaluate(()=>{sceneryRows=[{provider:'codex',session_id:'running',status:'running'}];driveScenery()});await page.waitForTimeout(650);
 await page.emulateMedia({reducedMotion:'reduce'});const reduced=await read();await page.waitForTimeout(250);assert(JSON.stringify(reduced)===JSON.stringify(await read()),'reduced motion pauses');await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'))});const hidden=await read();await page.waitForTimeout(200);assert(JSON.stringify(hidden)===JSON.stringify(await read()),'hidden pauses');await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))});
 await page.evaluate(()=>{const now=Date.now()/1000;applyState({...data,server_time:now,snapshot:{...data.snapshot,at:now-60}})});const stale=await read();await page.waitForTimeout(200);assert(JSON.stringify(stale)===JSON.stringify(await read()),'stale pauses');
 await page.evaluate(()=>driveScenery());
 for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no overflow '+width);assert(await page.locator('.workshop-panel').evaluate(e=>e.getBoundingClientRect().height)===(width<760?695:461),'same panel size '+width);}
 await page.waitForTimeout(700);await page.screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/scenery-motion.png'});
 assert(!errors.length,errors.join('\n'));return {passed:true,travel,checks:'independent roads, idle, speeds, parallax ratio, stop, waiting/failed/unknown, reduced, hidden, stale, responsive size',errors};
}
const r=spawnSync('playwright-cli',['-s=scenery','run-code',suite.toString()],{encoding:'utf8',maxBuffer:1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error/.test(r.stdout)?1:0));
