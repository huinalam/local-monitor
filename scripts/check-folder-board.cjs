const {spawnSync}=require('node:child_process');
async function suite(page){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const assert=(v,m)=>{if(!v)throw Error(m)};
 await page.addInitScript(()=>window.EventSource=class{addEventListener(){}close(){}});
 await page.route('**/api/state',r=>r.fulfill({json:{instance:'folders',seq:0,server_time:Date.now()/1000,snapshot:{at:Date.now()/1000,sessions:[],errors:[]},events:[],usage:[],collector_error:false}}));
 await page.goto('http://127.0.0.1:3010/');await page.waitForFunction(()=>typeof data!=='undefined'&&data?.instance==='folders');
 await page.evaluate(()=>{const now=Date.now()/1000;window.rows=[{provider:'codex',session_id:'a',cwd:'/work/local-monitor',title:'현황판 폴더별 작업 목록 구성',status:'running'},{provider:'claude',session_id:'b',cwd:'/work/local-monitor',title:'모바일 레이아웃 검토',status:'waiting_input'},{provider:'antigravity',session_id:'c',cwd:'/work/local-monitor',title:'계정 식별 연결 점검',status:'completed',completed_at:now-900},{provider:'codex',session_id:'d',cwd:'/other/local-monitor',title:'<img src=x> 안전한 작업명',status:'completed',completed_at:now-60},{provider:'claude',session_id:'e',cwd:'/work/honeygasm',title:'광고 수익 분석 화면 개선',status:'background'}];window.showRows=()=>{const n=Date.now()/1000;serverClock.observe(n);applyState({...data,server_time:n,snapshot:{at:n,errors:[],sessions:rows}})};showRows();});
 assert(await page.locator('.folder-provider svg').count()===3,'provider portraits');
 assert(await page.locator('.folder-provider').first().getAttribute('title'),'provider tooltip');
 assert(await page.locator('.folder-group').count()===3,'full path groups');assert(await page.locator('.folder-task').count()===3,'visible rows');assert(await page.locator('.folder-task img').count()===0,'safe text');
 assert(await page.locator('.folder-pie').first().evaluate(e=>getComputedStyle(e).backgroundImage.includes('conic-gradient')),'pie is painted');
 const fade=await page.evaluate(()=>{
  const now=Date.now()/1000,read=()=>{const e=document.querySelector('.folder-task[data-provider=codex][data-status=completed]');return {tint:parseFloat(e.style.getPropertyValue('--completion-tint')),color:getComputedStyle(e).backgroundColor,height:e.getBoundingClientRect().height}};
  folderBoard.render(data,now,false);const fresh=read();folderBoard.render(data,now+600,false);const older=read();folderBoard.render(data,now+1200,true);const frozen=read();
  folderBoard.render({...data,snapshot:{...data.snapshot,sessions:data.snapshot.sessions.map(r=>r.session_id==='d'?{...r,status:'running'}:r)}},now,false);
  const resumed=[...document.querySelectorAll('.folder-task')].find(e=>e.dataset.focusKey==='task:'+JSON.stringify(['codex','d']));const cleared=!resumed;
  folderBoard.render(data,now,false);return {fresh,older,frozen,cleared};
 });
 assert(fade.fresh.tint>fade.older.tint&&fade.older.tint>0&&fade.fresh.color!==fade.older.color,'completion tint fades');
 assert(fade.older.tint===fade.frozen.tint&&fade.older.color===fade.frozen.color,'offline tint freezes');
 assert(fade.cleared&&fade.fresh.height===fade.older.height,'resume removes tint without resizing');

 await page.locator('[data-workshop-provider=codex] .workshop-scene').click();assert(await page.locator('.folder-task').count()===1,'provider filter');
 await page.locator('.settings summary').click();await page.locator('#workshop-all').click();assert(await page.locator('.folder-task').count()===3,'all reset');
 assert(await page.locator('.folder-search').count()===0,'search removed');
 assert(await page.locator('.settings #workshop-all').count()===1,'all tools in settings');
 assert(await page.locator('.folder-filters').count()===0,'status filters removed');
 await page.locator('.folder-task[data-status=completed]').first().click();assert(await page.locator('#sessions .session').count()===1,'specific completed journal');await page.keyboard.press('Escape');
 const toggle=page.locator('.folder-toggle').first();await toggle.click();await page.evaluate(()=>showRows());assert(await toggle.getAttribute('aria-expanded')==='false','collapse retained');await toggle.click();
 await page.evaluate(()=>{rows=rows.map(r=>r.session_id==='c'?{...r,status:'running'}:r);showRows()});assert(await page.locator('.folder-pie').count()===1,'resume removes pie');
 await page.evaluate(()=>{rows=rows.map(r=>r.session_id==='d'?{...r,completed_at:Date.now()/1000-1799.5}:r);showRows()});await page.waitForFunction(()=>document.querySelectorAll('.folder-pie').length===0);assert(await page.locator('.folder-task').count()===1,'expiry removes row');
 await page.evaluate(()=>{transportError(Error('offline'));transportError(Error('offline'));rows=[];});assert((await page.locator('.folder-notice').textContent()).includes('이전 관측값'),'offline');assert(await page.locator('.folder-task').count()===1,'offline rows held');
 await page.evaluate(()=>{const now=Date.now()/1000;rows=['codex','claude','antigravity'].flatMap((provider,i)=>[{provider,session_id:provider,cwd:'/work/local-monitor',title:'도구별 진행 작업의 긴 제목을 표시합니다',status:'running'},{provider,session_id:provider+'done',cwd:'/work/honeygasm',title:'최근 완료 작업',status:'completed',completed_at:now-500}]);showRows()});
 for(const width of [320,390,768,1280]){
  await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow '+width);
  const height=await page.locator('.workshop-panel').evaluate(e=>e.getBoundingClientRect().height);assert(height<=(width<760?760:520),'compact height '+width+'/'+height);
  assert(await page.locator('.workshop-recent:visible').count()===0,'sidebar duplicates hidden');
  const rowHeight=await page.locator('.folder-task').first().evaluate(e=>e.getBoundingClientRect().height);assert(rowHeight<=(width<=420?124:106),'dense rows '+width+'/'+rowHeight);
  assert(await page.locator('.folder-toggle').first().evaluate(e=>e.getBoundingClientRect().height)<=28,'dense folder heading');
  const placement=await page.locator('.folder-task[data-status=completed]').first().evaluate(e=>{const r=s=>e.querySelector(s).getBoundingClientRect();return {icon:r('.folder-provider').left,iconRight:r('.folder-provider').right,pie:r('.folder-pie').left,pieRight:r('.folder-pie').right,title:r('.folder-task-title').left,state:r('.folder-task-state').left,pieWidth:r('.folder-pie').width}});
  assert(placement.pieRight<=placement.icon&&placement.pieWidth===10&&placement.state>placement.pieRight,'pie before portrait '+width);
  if(width>420)assert(placement.title>placement.iconRight,'title after portrait '+width);

  const boxes=await page.locator('.workshop-room').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().toJSON()));assert(boxes[2].y>boxes[0].bottom,'responsive agents');
  await page.screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/folders-'+width+'.png'});
 }
 await page.evaluate(()=>{const now=Date.now()/1000;rows=Array.from({length:40},(_,i)=>({provider:'codex',session_id:'many'+i,cwd:'/work/large',title:'많은 작업 '+i,status:'waiting_input'}));showRows()});
 assert(await page.locator('.folder-list').evaluate(e=>e.scrollHeight>e.clientHeight),'internal scroll');
 assert(await page.locator('.workshop-panel').evaluate(e=>e.getBoundingClientRect().height)<=520,'many rows keep height');
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/folders-dark.png'});
 assert(!errors.length,errors.join('\n'));return {passed:true,checks:'path grouping, provider filter, no status tabs, dense rows, settings reset, search removed, compact height, internal scroll, collapse, specific journal, resume, expiry, stale, mobile, dark',errors};
}
const r=spawnSync('playwright-cli',['-s=folders','run-code',suite.toString()],{encoding:'utf8',maxBuffer:1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error/.test(r.stdout)?1:0));
