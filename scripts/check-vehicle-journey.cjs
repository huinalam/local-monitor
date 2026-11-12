const {spawnSync}=require('node:child_process');
async function suite(page){
 const assert=(v,m)=>{if(!v)throw Error(m)},errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await page.goto('http://127.0.0.1:3012');
 await page.evaluate(()=>{
  const old=document.getElementById('workshop-grid'),grid=old.cloneNode(false);old.replaceWith(grid);
  window.__ride=LocalMonitorWorkshop.create(grid,(p,mode)=>window.__plateClick={p,mode},()=>{},r=>r.windows);
  window.__vehicleFixture=(count,status='running',stale=false,reset=true)=>{
   const now=Date.now()/1000,providers=['codex','claude','antigravity'];
   const state={snapshot:{at:now,sessions:[...providers.flatMap(provider=>Array.from({length:Math.max(1,count)},(_,i)=>({provider,session_id:String(i),status:count?status:status==='running'?'idle':status}))),{provider:'codex',session_id:'done',status:'completed',completed_at:now-5}]},completion_window:{schema:1,seconds:600,entries:[{provider:'codex',session_id:'done',turn_id:'1',at:now-5}]},usage:providers.map(provider=>({provider,status:'ok',observed_at:now,windows:[{label:'주간',daily:{status:'ok',recommended:20,used:5}}]}))};
   if(reset)__ride.reset();__ride.render(state,now,stale);return now;
  };
 });
 const room=p=>page.locator(`[data-workshop-provider=${p}]`);
 for(const [count,tier] of [[1,'1'],[2,'2'],[3,'2'],[4,'3'],[120,'3']]){
  await page.evaluate(n=>__vehicleFixture(n),count);
  for(const p of ['codex','claude','antigravity']){
   assert(await room(p).getAttribute('data-vehicle')===tier,'tier '+p+count);
   assert(await room(p).locator('.journey-task-badge').textContent()===String(count),'exact plate');
   assert(await room(p).locator('.ride-body').evaluateAll(es=>es.filter(e=>getComputedStyle(e).display!=='none').length)===1,'one visible vehicle');
   assert(await room(p).locator('.ws-leg').first().evaluate(e=>getComputedStyle(e).visibility)==='hidden','no running legs');
  }
  for(const width of [320,390,1024]){
   await page.setViewportSize({width,height:900});
   const layout=await page.locator('.workshop-room').evaluateAll(es=>es.map(e=>{
    const hp=e.querySelector('.journey-overlay').getBoundingClientRect(),face=e.querySelector('.ws-person').getBoundingClientRect(),plate=e.querySelector('.journey-task-badge').getBoundingClientRect(),box=e.getBoundingClientRect();
    return {clear:hp.bottom<=face.top,inside:plate.left>=box.left&&plate.right<=box.right&&hp.top>=box.top};
   }));
   assert(layout.every(r=>r.clear&&r.inside),'readout layout '+count+'/'+width+JSON.stringify(layout));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no overflow');
  }
  if(count!==3&&count!==120)await page.locator('.workshop-panel').screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/vehicles-tier-'+tier+'.png'});
 }
 await page.setViewportSize({width:320,height:900});
 await room('codex').locator('.journey-task-badge').focus();await page.keyboard.press('Enter');assert(await page.evaluate(()=>__plateClick.p==='codex'&&__plateClick.mode==='running'),'plate keyboard filter');
 await page.locator('.workshop-panel').screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/vehicles-mobile.png'});
 for(const status of ['idle','waiting_input','failed','unknown']){
  await page.evaluate(s=>__vehicleFixture(0,s,false,false),status);
  assert(await room('codex').getAttribute('data-vehicle')==='3','parked retains last ride');
  assert(await room('codex').getAttribute('data-riding')==='false','immediate stop '+status);
  assert(await room('codex').locator('.ride-rig').evaluate(e=>getComputedStyle(e).animationName)==='none','parked does not move');
  if(status==='waiting_input'||status==='failed')assert(await room('codex').locator('.ride-tier-3 .ride-warning').evaluate(e=>getComputedStyle(e).display)!=='none','warning lamp');
 }
 await page.evaluate(()=>{__vehicleFixture(4);__ride.celebrate([{provider:'codex',session_id:'done',at:Date.now()/1000}],Date.now()/1000)});
 assert(await room('codex').locator('.ride-rig').evaluate(e=>getComputedStyle(e).animationName)==='ride-arrival','completion nudge');
 assert(await room('codex').locator('.ride-tier-3 .ride-boost').evaluate(e=>getComputedStyle(e).display)!=='none','completion thrust');
 await page.emulateMedia({reducedMotion:'reduce'});
 assert(await room('codex').locator('.ride-rig').evaluate(e=>getComputedStyle(e).animationName)==='none','reduced motion');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>{__vehicleFixture(4);__vehicleFixture(4,'running',true,false)});
 assert(await room('codex').getAttribute('data-riding')==='false','stale stops');
 await page.evaluate(()=>{__vehicleFixture(2);Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))});
 assert(await room('codex').locator('.ride-rig').evaluate(e=>getComputedStyle(e).animationPlayState)==='paused','hidden pause');
 assert(!errors.length,errors.join('\n'));return {passed:true,checks:'9 vehicles, exact120 plate, 320/390/1024 layout, keyboard, idle/wait/failed/unknown/stale, completion, reduced/hidden, CSP',errors};
}
const r=spawnSync('playwright-cli',['-s=vehicles','run-code',suite.toString()],{encoding:'utf8',maxBuffer:1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error|Error:|TimeoutError/.test(r.stdout||'')?1:0));
