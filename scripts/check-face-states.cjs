const {spawnSync}=require('node:child_process');
async function suite(page){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const assert=(v,m)=>{if(!v)throw Error(m)};
 await page.addInitScript(()=>window.EventSource=class{addEventListener(){}close(){}});
 await page.route('**/api/state',r=>r.fulfill({json:{instance:'faces',seq:0,server_time:Date.now()/1000,snapshot:{at:Date.now()/1000,sessions:[],errors:[]},events:[],usage:[],collector_error:false}}));
 await page.goto('http://127.0.0.1:3010/');await page.waitForFunction(()=>typeof data!=='undefined'&&data?.instance==='faces');
 await page.evaluate(()=>{const now=Date.now()/1000;window.faceRows=['running','background','waiting_input','failed','unknown','completed'].flatMap(status=>['codex','claude','antigravity'].map(provider=>({provider,session_id:provider+status,cwd:'/work/'+status,title:'상태별 얼굴 확인 · '+status,status,completed_at:status==='completed'?now-60:undefined,updated_at:now})));window.showFaces=()=>{const now=Date.now()/1000;serverClock.observe(now);applyState({...data,server_time:now,snapshot:{at:now,errors:[],sessions:faceRows}})};showFaces();});
 assert(await page.locator('.folder-provider svg').count()===18,'six states for three tools');
 assert(await page.locator('.face-arrival').count()===0,'initial completion does not flash');
 const renderings=await page.locator('.folder-task[data-provider=codex] .folder-provider').evaluateAll(es=>es.map(e=>e.innerHTML));assert(new Set(renderings).size===6,'six distinct expressions');
 for(const width of [320,390,768,1280]){
  await page.setViewportSize({width,height:900});
  const dimensions=await page.locator('.workshop-panel').evaluate(e=>({height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top}));
  assert(dimensions.height===(width<760?695:461)&&dimensions.top===(width<760?40:36),'baseline geometry '+width+JSON.stringify(dimensions));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
  assert(await page.locator('.folder-task-state').evaluateAll(es=>es.every(e=>e.getBoundingClientRect().height===18&&e.scrollWidth<=e.clientWidth)),'state fits one line');
 }
 const active=page.locator('.folder-task[data-status=running] .folder-provider svg').first();
 assert(await active.evaluate(e=>getComputedStyle(e).animationName)==='face-active-sway','active animation');
 assert(await active.evaluate(e=>getComputedStyle(e).animationDuration)==='1.4s','active sway duration');
 const motion=await active.evaluate(e=>{e.style.animationDelay='0s';const a=e.getAnimations()[0];a.pause();const values=[0,700,1400].map(ms=>{a.currentTime=ms;return getComputedStyle(e).transform});a.play();e.style.removeProperty('animation-delay');return values;});assert(motion[0]!==motion[1]&&motion[0]===motion[2],'sways and returns without rolling');
 assert(await page.locator('.folder-task[data-status=running] .folder-provider').evaluateAll(es=>new Set(es.map(e=>e.style.getPropertyValue('--face-phase'))).size)>1,'staggered phases');
 assert(await page.locator('.folder-task[data-status=background] svg').first().evaluate(e=>getComputedStyle(e).animationDuration)==='5s','slower background');
 for(const state of ['waiting_input','failed','unknown','completed'])assert(await page.locator('.folder-task[data-status='+state+'] .folder-provider svg').first().evaluate(e=>getComputedStyle(e).animationName)==='none','stationary '+state);
 await page.evaluate(()=>{faceRows=faceRows.map(r=>r.session_id==='codexrunning'?{...r,status:'completed',completed_at:Date.now()/1000}:r);showFaces()});
 assert(await page.locator('.face-arrival').count()===1,'observed completion flashes once');
 await page.waitForTimeout(850);assert(await page.locator('.face-arrival').count()===0,'flash ends');
 await page.evaluate(()=>{faceRows=faceRows.map(r=>({...r,title:r.title+'!'}));showFaces()});assert(await page.locator('.face-arrival').count()===0,'redraw does not replay');
 await page.locator('[data-workshop-provider=codex] .workshop-scene').click();assert(await page.locator('.face-arrival').count()===0,'filter does not replay');await page.locator('[data-workshop-provider=codex] .workshop-scene').click();
 await page.evaluate(()=>folderBoard.render(data,Date.now()/1000,true));assert(await active.evaluate(e=>getComputedStyle(e).animationName)==='none','offline motion stopped');await page.evaluate(()=>showFaces());
 await page.emulateMedia({reducedMotion:'reduce'});assert(await active.evaluate(e=>getComputedStyle(e).animationName)==='none','reduced motion');await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'))});assert(await active.evaluate(e=>getComputedStyle(e).animationName)==='none','hidden motion stopped');await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))});
 for(const theme of ['light','dark']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/face-states-'+theme+'.png'});}
 assert(!errors.length,errors.join('\n'));return {passed:true,checks:'18 portraits, six expressions, baseline dimensions, single-line status, pacing, completion once, redraw/filter, offline, reduced motion, hidden',errors};
}
const r=spawnSync('playwright-cli',['-s=faces','run-code',suite.toString()],{encoding:'utf8',maxBuffer:1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error/.test(r.stdout)?1:0));
