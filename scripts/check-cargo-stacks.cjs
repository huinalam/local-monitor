const {spawnSync}=require('node:child_process');
async function suite(page){
 const assert=(v,m)=>{if(!v)throw Error(m)};
 await page.addInitScript(()=>window.EventSource=class{addEventListener(){}close(){}});
 await page.route('**/api/state',r=>r.fulfill({json:{instance:'cargo',seq:0,server_time:Date.now()/1000,snapshot:{at:Date.now()/1000,sessions:[],errors:[]},events:[],usage:[],collector_error:false}}));
 await page.goto('http://127.0.0.1:3010/');
 await page.waitForFunction(()=>typeof data!=='undefined'&&data?.instance==='cargo');
 await page.evaluate(()=>window.showCargo=(count,status='running')=>{const now=Date.now()/1000;serverClock.observe(now);applyState({...data,server_time:now,snapshot:{at:now,errors:[],sessions:['codex','claude','antigravity'].flatMap(provider=>Array.from({length:count},(_,i)=>({provider,session_id:provider+i,cwd:'/fixture',title:'작업 '+i,status,completed_at:status==='completed'?now-30:undefined})))}})});
 const room=page.locator('[data-workshop-provider=codex]');
 for(const status of ['running','completed'])for(const count of [0,1,2,3,4,12]){
  await page.evaluate(({count,status})=>showCargo(count,status),{count,status});
  const button=room.locator(status==='running'?'.journey-task-badge':'.journey-done-badge');
  assert(await button.locator('.cargo-item').count()===Math.min(3,count),status+' pieces '+count);
  assert(await button.locator('.cargo-more').isVisible()===(count>3),'overflow');
  assert((await button.getAttribute('aria-label')).includes(count+'개'),'exact count');
  assert(!/\d/.test(await button.textContent()),'no visual numeric count');
 }
 await page.evaluate(()=>showCargo(4,'completed'));await room.locator('.journey-done-badge').focus();await page.keyboard.press('Enter');
 assert(await page.locator('#sessions .session').count()===4,'journal keyboard');await page.keyboard.press('Escape');
 for(const status of ['unknown','waiting_input']){
  await page.evaluate(status=>showCargo(1,status),status);
  assert(await room.locator('.journey-task-badge .cargo-state').textContent()===(status==='unknown'?'?':'!'),'uncertainty');
 }
 await page.evaluate(()=>{showCargo(3,'completed');transportError(Error('offline'));transportError(Error('offline'))});
 assert(await room.locator('.journey-done-badge .cargo-item').count()===3,'offline preserved');
 assert(await room.locator('.journey-done-badge .cargo-state').textContent()==='?','offline mark');
 for(const width of [320,390,1280]){
  await page.setViewportSize({width,height:900});
  await page.evaluate(()=>{const now=Date.now()/1000;serverClock.observe(now);applyState({...data,snapshot:{at:now,errors:[],sessions:['codex','claude','antigravity'].flatMap(provider=>['running','completed'].flatMap(status=>Array.from({length:4},(_,i)=>({provider,session_id:provider+status+i,title:'Task',cwd:'/fixture',status,completed_at:now-30}))))}})});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no overflow');
  assert(await page.locator('.workshop-room').evaluateAll(rs=>rs.every(r=>{const hp=r.querySelector('.journey-hp').getBoundingClientRect();return [...r.querySelectorAll('.journey-cargo')].every(b=>{const x=b.getBoundingClientRect();return x.top>=hp.bottom&&x.height<=40})})),'hp clear');
  await page.screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/cargo-'+width+'.png'});
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 assert(await room.locator('[data-kind=active] .cargo-stack').evaluate(e=>getComputedStyle(e).animationName)==='none','reduced motion');
 return {passed:true,checks:'0/1/2/3/4/12, exact aria, keyboard journal, unknown, attention, offline, 320/390/1280, reduced motion'};
}
const r=spawnSync('playwright-cli',['-s=cargo','run-code',suite.toString()],{encoding:'utf8',maxBuffer:1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error/.test(r.stdout)?1:0));
