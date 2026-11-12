const {spawnSync}=require('node:child_process');
async function suite(page){
 const assert=(v,m)=>{if(!v)throw Error(m)},errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await page.addInitScript(()=>{window.EventSource=class{addEventListener(){}close(){}};window.Notification=class{static permission='denied'}});
 await page.route('**/api/state',r=>r.fulfill({json:{instance:'tasks',seq:0,server_time:Date.now()/1000,snapshot:{at:Date.now()/1000,sessions:[],errors:[]},events:[],usage:[],collector_error:false}}));
 await page.goto('http://127.0.0.1:3010');
 await page.evaluate(()=>{
  window.__setTasks=(rows)=>{const now=Date.now()/1000;serverClock.observe(now);applyState({...data,snapshot:{at:now,errors:[],sessions:rows},server_time:now,events:[],collector_error:false});};
  window.__task=(status='completed',at=Date.now()/1000)=>({provider:'codex',session_id:'task-A',status,completed_at:at,title:'Task A',cwd:'/fixture/tasks'});
 });
 const room=page.locator('[data-workshop-provider=codex]'),marker=room.locator('.journey-done-badge');
 await page.evaluate(()=>__setTasks([__task(),__task()]));
 assert(await marker.getAttribute('data-count')==='1','duplicate task one marker');assert(await room.locator('.workshop-recent-row:visible').count()===1,'same preview count');
 await marker.focus();await page.keyboard.press('Enter');assert(await page.locator('#sessions .session').count()===1,'one journal row');
 await page.evaluate(()=>__setTasks([__task('running')]));
 assert(await marker.getAttribute('data-count')==='0','resume removes completion');assert(await room.locator('.journey-task-badge').getAttribute('data-count')==='1','resume active');assert(await page.locator('#sessions .session').count()===0,'open journal removes resumed task');
 await page.evaluate(()=>__setTasks([__task()]));assert(await marker.getAttribute('data-count')==='1','recomplete one');assert(await page.locator('#sessions .session').count()===1,'open journal recompletion');
 for(const status of ['background','waiting_input','failed','unknown','idle','disconnected']){
  await page.evaluate(s=>__setTasks([__task(s)]),status);assert(await marker.getAttribute('data-count')==='0',status+' excluded');
 }
 await page.evaluate(()=>__setTasks([__task('completed',Date.now()/1000-1799.5)]));
 await page.waitForFunction(()=>document.querySelector('.journey-done-badge').dataset.count==='0',null,{timeout:3000});
 assert(await page.locator('#sessions .session').count()===0,'expiry updates open journal');
 await page.keyboard.press('Escape');assert(await marker.evaluate(e=>e===document.activeElement),'marker focus restored');
 await page.evaluate(()=>__setTasks([__task('completed',null)]));assert(await marker.getAttribute('data-count')==='0'&&(await marker.locator('.cargo-state').textContent())==='*','missing completion time partial');
 await page.evaluate(()=>{__setTasks([__task()]);transportError(new Error('offline'));transportError(new Error('offline'));});
 assert(await marker.getAttribute('data-count')==='1'&&(await marker.locator('.cargo-state').textContent())==='?','offline previous count');
 await page.evaluate(()=>__setTasks([__task('running')]));assert(await marker.getAttribute('data-count')==='0','recovery removes old completed task');
 await page.evaluate(()=>{__setTasks([__task()]);const now=Date.now()/1000;workshop.celebrate([{provider:'codex',session_id:'task-A',at:now},{provider:'codex',session_id:'task-A',at:now}],now)});
 assert(await room.locator('.workshop-cue').textContent()==='✓ +1','cue deduplicates task');
 await page.evaluate(()=>{workshop.reset();__setTasks([__task('running')]);workshop.celebrate([{provider:'codex',session_id:'task-A',at:Date.now()/1000}],Date.now()/1000)});
 assert(await room.locator('.workshop-cue').textContent()==='','resumed task has no completion cue');
 for(const count of [0,1,120]){
  await page.evaluate(n=>{const now=Date.now()/1000;__setTasks(['codex','claude','antigravity'].flatMap(provider=>[...Array.from({length:n},(_,i)=>({...__task(),provider,session_id:'done'+i,completed_at:now})),...Array.from({length:Math.max(1,n)},(_,i)=>({...__task('running'),provider,session_id:'active'+i}))]));},count);
  for(const width of [320,390,1024]){
   await page.setViewportSize({width,height:900});
   const positions=await page.locator('.workshop-room').evaluateAll(es=>es.map(e=>{
    const done=e.querySelector('.journey-done-badge').getBoundingClientRect(),active=e.querySelector('.journey-task-badge').getBoundingClientRect(),hp=e.querySelector('.journey-hp').getBoundingClientRect(),box=e.getBoundingClientRect();
    return {inside:done.left>=box.left&&done.right<=box.right,apart:done.right<=active.left,hp:done.top>=hp.bottom};
   }));
   assert(positions.every(p=>p.inside&&p.apart&&p.hp),'marker layout '+width+'/'+count+JSON.stringify(positions));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow');
   if(width!==390)await page.locator('.workshop-panel').screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/tasks-'+count+'-'+width+'.png'});
  }
 }
 await marker.click();assert(await page.locator('#sessions .session').count()===120,'large count exact drilldown');await page.keyboard.press('Escape');
 assert(!errors.length,errors.join('\n'));return {passed:true,checks:'duplicate/resume/recomplete/expiry/current-status/partial/stale/recovery/open-journal/cue/keyboard/0-1-120/mobile-layout',errors};
}
const r=spawnSync('playwright-cli',['-s=tasks','run-code',suite.toString()],{encoding:'utf8',maxBuffer:1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error|Error:|TimeoutError/.test(r.stdout||'')?1:0));
