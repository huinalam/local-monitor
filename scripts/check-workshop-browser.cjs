/* Run the browser acceptance suite through the installed playwright-cli session. */
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');const path=require('node:path');
const output=path.resolve('.agent-logs/2026-10-26--little-workshop-design/artifacts/browser');fs.mkdirSync(output,{recursive:true});
async function suite(page){
 const out=OUTPUT;const assert=(v,m)=>{if(!v)throw Error(m);};const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.context().clearPermissions();
 await page.addInitScript(()=>{
   window.__streams=[];window.__notifications=[];
   window.EventSource=class {constructor(){this.readyState=1;this.handlers={};window.__streams.push(this);}addEventListener(k,f){this.handlers[k]=f;}close(){this.readyState=2;}emit(k,data,id){this.handlers[k]?.({data:JSON.stringify(data),lastEventId:id});}};
   window.Notification=class{static permission='granted';constructor(...args){window.__notifications.push(args);}};
 });
 const t=Date.now()/1000;
 const session=(provider,id,status)=>({provider,session_id:id,status,title:'테스트 제작물 '+id,cwd:'/fixture/workshop',observed_at:t-3,turn_id:'next'});
 const entries=[1,2,3].map(i=>({id:'fixture:'+i,provider:'codex',session_id:'same',turn_id:String(i),title:i===1?'<img src=x onerror=alert(1)>':'작은 작업물 '+i,cwd:'/fixture/workshop',at:t-i*10}));
 const fixture={instance:'fixture',seq:3,stream_id:'fixture:1',server_time:t,snapshot:{at:t,errors:[],sessions:[session('codex','same','running'),session('codex','bg','background'),session('codex','wait','waiting_input'),session('claude','wait','waiting_input'),session('antigravity','rest','idle'),...[1,2,3].map(i=>({...session('codex','done'+i,'completed'),completed_at:t-i*10,title:i===1?'<img src=x onerror=alert(1)>':'완료 작업 '+i}))]},events:entries.map((e,i)=>({...e,seq:i+1})),collector_error:false,usage:[],system:{status:'loading',observed_at:null,cpu_percent:null},system_history:[],completion_window:{schema:1,seconds:600,as_of:t,coverage_since:t-1000,partial:false,reasons:[],entries}};
 await page.route('**/api/state',r=>r.fulfill({json:{...fixture,server_time:Date.now()/1000,snapshot:{...fixture.snapshot,at:Date.now()/1000}}}));
 await page.route('**/api/diagnostics**',r=>r.fulfill({json:{ok:true}}));
 await page.goto('http://127.0.0.1:3012/');await page.waitForFunction(()=>document.querySelector('[data-workshop-provider=codex] .journey-task-badge')?.textContent==='2');
 const room=p=>page.locator(`[data-workshop-provider=${p}]`);
 assert(await room('codex').getAttribute('data-pose')==='working','mixed work pose');assert(await room('claude').getAttribute('data-pose')==='waiting','waiting pose');assert(await room('antigravity').getAttribute('data-pose')==='sleeping','sleep pose');
 assert(await page.locator('.journey-landscape').count()===1,'one shared landscape');
 assert(await room('codex').getAttribute('data-gait')==='jog','two active tasks jog');
 assert(await room('codex').locator('.ws-finished-item.is-filled').count()===3,'completed tasks become lights');
 assert(await room('claude').getAttribute('data-gait')==='still','waiting does not walk');
 assert(await room('codex').locator('.journey-done-badge').textContent()==='✓ 3','three completed tasks');assert(await page.evaluate(()=>__notifications.length)===0,'baseline must not notify');
 await page.route('**/api/usage/*',r=>r.fulfill({json:{provider:'codex',status:'ok',windows:[],observed_at:Date.now()/1000}}));
 await page.evaluate(()=>{const now=Date.now()/1000;__streams.at(-1).emit('patch',{usage:[{provider:'codex',status:'ok',observed_at:now,windows:[{id:'weekly',label:'주간',group:'codex',remaining_percent:80,resets_at:now+86400,daily:{status:'ok',recommended:20,used:5,partial:true}}]}],server_time:now},'fixture:hp');});
 assert(await room('codex').locator('.journey-hp-text').textContent()==='75%*','daily remaining HP');
 assert(await room('antigravity').locator('.journey-hp').evaluate(e=>e.classList.contains('is-unknown')),'missing daily stays unknown');
 assert(await room('codex').locator('.journey-task-badge').textContent()==='2','active badge');
 assert(await room('codex').locator('.journey-task-badge').evaluate(e=>e.classList.contains('has-dot')),'mixed attention dot');
 assert(await room('claude').locator('.journey-task-badge').textContent()==='! 1','attention-only badge');
 assert(await room('antigravity').locator('.journey-task-badge').isHidden(),'idle hides badge');
 await room('codex').locator('.journey-hp').focus();await page.keyboard.press('Enter');
 assert(await page.locator('#usage-dialog').evaluate(e=>e.open),'HP opens usage detail');await page.keyboard.press('Escape');
 assert(await room('codex').locator('.journey-hp').evaluate(e=>document.activeElement===e),'HP focus restored');
 await room('codex').locator('.journey-task-badge').click();assert(await page.locator('#sessions .session').count()===2,'badge opens active filter');await page.keyboard.press('Escape');
 for(const width of [320,390,1024]){
   await page.setViewportSize({width,height:900});await page.waitForTimeout(500);
   assert(await room('codex').evaluate(e=>e.querySelector('.journey-overlay').getBoundingClientRect().bottom<=e.querySelector('.ws-person').getBoundingClientRect().top),'overlay clears head '+width);
   await page.locator('.workshop-panel').screenshot({path:out+'/hp-'+width+'.png'});
 }
 await page.evaluate(()=>{window.__beforeHistory=data.snapshot;const now=Date.now()/1000;__streams.at(-1).emit('patch',{snapshot:{...data.snapshot,at:now,sessions:[...data.snapshot.sessions,{provider:'claude',session_id:'old-unknown',status:'unknown',reason:'no_recent_evidence',observed_at:now-601,title:'Old evidence',cwd:'/fixture'},{provider:'codex',session_id:'current-unknown',status:'unknown',observed_at:now,title:'Current unknown',cwd:'/fixture'}]},server_time:now},'fixture:history');});
 assert(await room('claude').locator('.workshop-history').textContent()==='지난 미확인 1','separate old records');
 assert(await room('codex').locator('.journey-task-badge').textContent()==='2','known active count wins over individual unknown');
 await room('claude').locator('.workshop-history').click();
 assert(await page.locator('#sessions .session').count()===1,'historical-only drilldown');
 assert(await page.locator('#sessions .session').getAttribute('data-session-id')==='old-unknown','history keeps source record');
 await page.keyboard.press('Escape');assert(await room('claude').locator('.workshop-history').evaluate(e=>e===document.activeElement),'history focus restored');
 await page.setViewportSize({width:320,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'history mobile overflow');
 await page.locator('.workshop-panel').screenshot({path:out+'/registry-history-mobile.png'});
 await page.evaluate(()=>{const now=Date.now()/1000;__streams.at(-1).emit('patch',{snapshot:{...__beforeHistory,at:now},server_time:now},'fixture:history-reset');});
 const journeyChecks=await page.evaluate(()=>{
   const container=document.createElement('div');document.body.append(container);
   const view=LocalMonitorWorkshop.create(container,()=>{}),now=Date.now()/1000;
   const state=(n,done)=>({snapshot:{at:now,sessions:[...Array.from({length:n},(_,i)=>({provider:'codex',session_id:String(i),status:'running'})),...Array.from({length:done},(_,i)=>({provider:'codex',session_id:'done'+i,status:'completed',completed_at:now-1}))]},completion_window:{schema:1,seconds:600,entries:Array.from({length:done},(_,i)=>({provider:'codex',session_id:'x',turn_id:String(i),at:now-1}))}});
   const check=(v,m)=>{if(!v)throw Error(m);};
   for(const [n,gait] of [[0,'rest'],[1,'walk'],[2,'jog'],[3,'jog'],[4,'run'],[20,'run']]){
     view.render(state(n,8),now);check(container.querySelector('article').dataset.gait===gait,'gait '+n);
     check(container.classList.contains('journey-moving')===(n>0),'road '+n);
   }
   for(const n of [0,1,5,8]){
     view.render(state(1,n),now);check(container.querySelectorAll('.ws-finished-item.is-filled').length===Math.min(n,5),'footprints '+n);
     check(container.querySelector('.ws-count-overflow').textContent===(n>5?'+'+(n-5):''),'overflow '+n);
   }
   view.render(state(1,8),now+601);check(container.querySelectorAll('.is-filled').length===0,'expired footprints');
   view.render(state(1,8),now,true);check(!container.classList.contains('journey-moving'),'stale road');
   const shared=state(1,8);shared.snapshot.sessions.push({provider:'claude',session_id:'done',status:'completed',completed_at:now});view.render(shared,now);view.celebrate([{provider:'codex',session_id:'done0',at:now},{provider:'claude',session_id:'done',at:now}],now);
   check(container.classList.contains('journey-celebrating'),'shared arrivals');view.reset();check(!container.classList.contains('journey-celebrating'),'reset clears glow');
   container.remove();return 'gaits, capped footprints, expiry, road pause, shared arrivals';
 });
 console.log(journeyChecks);
 await page.setViewportSize({width:1024,height:800});await page.screenshot({path:out+'/mixed-desktop.png'});
 await room('codex').locator('.journey-done-badge').click();assert(await page.locator('#sessions [data-event-id]').count()===3,'completion drilldown');assert(await page.locator('#sessions img').count()===0,'title escaped');await page.screenshot({path:out+'/journal-completed.png'});
 await page.keyboard.press('Escape');assert(await room('codex').locator('.journey-done-badge').evaluate(e=>e===document.activeElement),'focus restored');
 await room('codex').locator('.journey-task-badge').click();assert(await page.locator('#sessions .session').count()===2,'running filter excludes wait/completed');await page.locator('#workshop-close').click();
 await room('codex').locator('.workshop-scene').click();assert(await page.locator('#sessions .session').count()===6,'scene opens provider sessions');await page.keyboard.press('Escape');
 await page.locator('#workshop-open').click();assert(await page.locator('#sessions .session').count()===8,'all sessions default');await page.locator('#search').fill('same');assert(await page.locator('#sessions .session').count()===1,'search');assert(await room('codex').locator('.journey-task-badge').textContent()==='2','journal filters do not change counts');await page.keyboard.press('Escape');
 await page.evaluate(()=>{window.__originalScene=document.querySelector('.workshop-scene svg');__streams.at(-1).emit('patch',{system:{status:'loading',cpu_percent:20},server_time:Date.now()/1000},'fixture:2');});
 assert(await page.evaluate(()=>__originalScene===document.querySelector('.workshop-scene svg')),'CPU preserves SVG identity');
 const push=async(fn)=>page.evaluate(fn);
 await push(()=>{const now=Date.now()/1000;const e={id:'fixture:4',seq:4,provider:'codex',session_id:'done4',turn_id:'4',title:'완성!',cwd:'/fixture',at:now};window.__newEvent=e;__streams.at(-1).emit('patch',{events:[e],seq:4,snapshot:{...data.snapshot,at:now,sessions:[...data.snapshot.sessions,{...e,status:'completed',completed_at:now}]},completion_window:{schema:1,seconds:600,as_of:now,coverage_since:now-1000,partial:false,reasons:[],entries:[...data.completion_window.entries,e]},server_time:now},'fixture:3');});
 assert(await room('codex').locator('.journey-done-badge').textContent()==='✓ 4','live completion count');assert(await room('codex').locator('.workshop-cue').textContent()==='✓ +1','live cue');assert(await page.evaluate(()=>__notifications.length)===1,'one notification');
 await push(()=>__streams.at(-1).emit('patch',{events:[__newEvent],seq:4,server_time:Date.now()/1000},'fixture:4'));
 assert(await page.evaluate(()=>__notifications.length)===1,'duplicate does not notify');
 await push(()=>__streams.at(-1).emit('reset',{...data,server_time:Date.now()/1000},'fixture:5'));
 assert(await room('codex').locator('.workshop-cue').textContent()==='','reset no cue');assert(await page.evaluate(()=>__notifications.length)===1,'reset no notification');
 await page.emulateMedia({reducedMotion:'reduce'});
 assert(await room('codex').locator('.ws-arm').evaluate(e=>getComputedStyle(e).animationName)==='none','reduced motion');await page.screenshot({path:out+'/reduced-motion.png'});
 await page.emulateMedia({reducedMotion:'no-preference'});
 await push(()=>{transportError(new Error('unavailable'));transportError(new Error('unavailable'));});
 assert(await room('codex').getAttribute('data-pose')==='unknown','offline not sleeping');assert(await room('codex').locator('.journey-task-badge').textContent()==='?','offline uncertain badge');await page.screenshot({path:out+'/offline.png'});
 await push(()=>__streams.at(-1).emit('patch',{snapshot_at:Date.now()/1000,server_time:Date.now()/1000},'fixture:6'));
 for(const theme of ['light','dark','rpg','night','real','cloud']){
   await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.dispatchEvent(new Event('themechange'));__streams.at(-1).emit('patch',{snapshot_at:Date.now()/1000,server_time:Date.now()/1000},'fixture:'+String(10+['light','dark','rpg','night','real','cloud'].indexOf(theme)));},theme);
   await page.screenshot({path:out+'/theme-'+theme+'.png'});
 }
 await page.evaluate(()=>document.documentElement.dataset.theme='light');
 for(const width of [320,390,768,1024]){
   await page.setViewportSize({width,height:900});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow '+width);
   await page.screenshot({path:out+'/width-'+width+'.png'});
   await room('codex').locator('.journey-done-badge').click();
   assert(await page.locator('#workshop-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),'dialog overflow '+width);
   await page.keyboard.press('Escape');
 }
 await page.evaluate(()=>document.documentElement.style.zoom='2');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'200% zoom');await page.evaluate(()=>document.documentElement.style.zoom='');
 await push(()=>{const now=Date.now()/1000;__streams.at(-1).emit('patch',{snapshot:{...data.snapshot,at:now,sessions:data.snapshot.sessions.map(r=>r.status==='completed'?{...r,completed_at:r.session_id==='done4'?now-599.9:now-601}:r)},server_time:now},'fixture:20');});
 await page.waitForFunction(()=>document.querySelector('[data-workshop-provider=codex] .journey-done-badge').textContent==='✓ 0',null,{timeout:3000});
 await push(()=>__streams.at(-1).emit('reset',{...data,completion_window:undefined,server_time:Date.now()/1000},'fixture:21'));
 assert(await room('codex').locator('.journey-done-badge').textContent()==='✓ 0','legacy snapshot supports task counts without event history');
 await push(()=>{const now=Date.now()/1000;__streams.at(-1).emit('patch',{snapshot:{at:now,errors:[],sessions:[{provider:'codex',session_id:'x',status:'unknown',title:'unknown',cwd:''},{provider:'claude',session_id:'y',status:'failed',title:'failed',cwd:''}]},server_time:now},'fixture:22');});
 assert(await room('codex').getAttribute('data-pose')==='unknown','unknown not sleeping');assert(await room('claude').getAttribute('data-pose')==='failed','failure pose');
 await push(()=>{const now=Date.now()/1000;__streams.at(-1).emit('patch',{snapshot:{...data.snapshot,at:now,errors:['source_error']},server_time:now},'fixture:23');});
 assert(await room('antigravity').getAttribute('data-pose')==='unknown','source error must not look idle');
 await push(()=>{const now=Date.now()/1000;__streams.at(-1).emit('patch',{snapshot:{...data.snapshot,at:now,errors:[]},server_time:now},'fixture:24');Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));const e={...__newEvent,id:'fixture:5',seq:5,turn_id:'5',at:now};__streams.at(-1).emit('patch',{events:[e],seq:5,server_time:now},'fixture:25');});
 assert(await room('codex').locator('.workshop-cue').textContent()==='','hidden tab has no cue');
 await push(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
 assert(await room('codex').locator('.workshop-cue').textContent()==='','foreground does not replay cue');
 await push(async()=>{stream.close();stream=null;window.EventSource=undefined;streamCursor=null;await pollFallback();});
 assert(await room('codex').locator('.journey-task-badge').textContent()==='2','HTTP fallback restores snapshot');
 await push(()=>{const now=Date.now()/1000;applyState({...data,collector_error:true,instance:'failed-start',server_time:now,snapshot:{at:now,errors:[],sessions:[]}},{},true);});
 assert(await room('codex').locator('.journey-task-badge').textContent()==='?','failed initial load has no invented zero');
 await push(()=>{const now=Date.now()/1000;applyState({...data,collector_error:false,instance:'retention',seq:0,events:[],server_time:now,snapshot:{at:now,errors:[],sessions:[{provider:'codex',session_id:'recent',status:'completed',completed_at:now-1199,observed_at:now-1199,title:'recent',cwd:''},{provider:'codex',session_id:'old',status:'completed',completed_at:now-1200,observed_at:now-1200,title:'old',cwd:''}]}},{},true);});
 await page.locator('#workshop-open').click();await page.locator('#session-tools [data-filter=active]').click();
 assert(await page.locator('#sessions .session').count()===1,'existing 20-minute retention boundary');
 await page.keyboard.press('Escape');
 assert(errors.length===0,'page errors: '+errors.join(','));
 return {passed:true,checks:'mixed poses, counts, repeated turns, escaping, drilldowns, focus, search, DOM isolation, live/replay/reset, reduced motion, offline, 6 themes, 4 widths, zoom, expiry, legacy, unknown, failed, source error, hidden tab, HTTP fallback, failed initial load, 20-minute retention',pageErrors:errors};
}
const source=suite.toString().replace('OUTPUT',JSON.stringify(output));
const r=spawnSync('playwright-cli',['-s=workshop','run-code',source],{encoding:'utf8',maxBuffer:1024*1024});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
process.exit(r.status||(/### Error|Error:|TimeoutError/.test(r.stdout||'')?1:0));
