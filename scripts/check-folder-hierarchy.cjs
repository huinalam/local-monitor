const {spawnSync}=require('node:child_process');
const {readFileSync,mkdirSync}=require('node:fs');
const dir='.agent-logs/2026-11-05--folder-hierarchy-review/artifacts';
mkdirSync(dir,{recursive:true});
// Optionally compare against geometry captured before the product change.
const baseline=process.argv[2]?JSON.parse(readFileSync(process.argv[2],'utf8').split('### Result\n')[1].split('\n###')[0]):null;
async function suite(page,baseline){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const assert=(v,m)=>{if(!v)throw Error(m)};
 await page.addInitScript(()=>window.EventSource=class{addEventListener(){}close(){}});
 await page.route('**/api/state',r=>r.fulfill({json:{instance:'hierarchy',seq:0,server_time:Date.now()/1000,snapshot:{at:Date.now()/1000,sessions:[],errors:[]},events:[],usage:[],collector_error:false}}));
 await page.setViewportSize({width:1280,height:1000});await page.goto('http://127.0.0.1:3010/');
 await page.waitForFunction(()=>data?.instance==='hierarchy');
 await page.evaluate(()=>{fallbackActive=false;clearTimeout(fallbackTimer)});
 if(!baseline){
  baseline=[];
  for(const theme of ['light','dark'])for(const system of [true,false])for(const width of [320,390,768,1280]){
   await page.setViewportSize({width,height:1000});
   baseline.push(await page.evaluate(({theme,system,width})=>{
    document.documentElement.dataset.theme=theme;document.querySelector('.integrated-sidebar').classList.toggle('without-system',!system);
    const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
    return {theme,system,width,panel:rect('.workshop-panel'),board:rect('.folder-board')};
   },{theme,system,width}));
  }
  await page.setViewportSize({width:1280,height:1000});
 }
 await page.evaluate(()=>{
  const now=Date.now()/1000;
  window.hierarchyRows=[
   {provider:'claude',session_id:'root',cwd:'/work/app',title:'프로젝트 작업',status:'completed',completed_at:now-100},
   {provider:'codex',session_id:'src',cwd:'/work/app/src',title:'소스 개선 작업',status:'background'},
   {provider:'codex',session_id:'tests',cwd:'/work/app/tests',title:'소스 검토',status:'waiting_input'},
   {provider:'codex',session_id:'deep',cwd:'/work/app/src/ui/components',title:'화면 개선 완료',status:'completed',completed_at:now-100},
   {provider:'antigravity',session_id:'docs',cwd:'/work/app/docs',title:'문서 검토',status:'failed'},
   {provider:'antigravity',session_id:'other',cwd:'/work/application',title:'별도 프로젝트',status:'running'}
  ];
  window.hierarchyUpdate=(at=Date.now()/1000)=>{serverClock.observe(at);applyState({...data,server_time:at,snapshot:{at,errors:[],sessions:hierarchyRows}})};
  window.hierarchyGroup=path=>[...document.querySelectorAll('.folder-group')].find(e=>e.dataset.layoutKey==='folder:'+path);
  window.hierarchyChip=path=>[...document.querySelectorAll('.folder-chip')].find(e=>e.dataset.focusKey==='chip:'+path);
  window.hierarchyRail=path=>[...document.querySelectorAll('.folder-chip-row')].find(e=>e.dataset.path===path);
  hierarchyUpdate();
 });
 await page.waitForTimeout(450);
 assert(await page.evaluate(()=>document.querySelectorAll('.folder-group').length===2&&document.querySelectorAll('.folder-chip').length===3&&document.querySelectorAll('.folder-task').length===1&&hierarchyGroup('/work/app').querySelector('.folder-summary').textContent==='진행 1 · 확인 2 · 완료 2'),'roots only, chips and descendant counts');
 assert(await page.evaluate(()=>hierarchyChip('/work/app/src').querySelector('.folder-chip-count').textContent==='2'&&hierarchyChip('/work/app/tests').querySelector('.folder-chip-attention')&&hierarchyRail('/work/app').clientHeight===24),'compact rail, counts and attention');
 await page.screenshot({path:'.agent-logs/2026-11-05--folder-hierarchy-review/artifacts/chips-collapsed.png'});
 const positions=await page.evaluate(()=>[...hierarchyRail('/work/app').querySelectorAll('.folder-chip')].map(e=>({key:e.dataset.focusKey,x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y})));
 await page.evaluate(()=>hierarchyChip('/work/app/src').click());
 assert(await page.evaluate(()=>hierarchyGroup('/work/app/src')&&hierarchyChip('/work/app/src/ui/components').querySelector('.folder-chip-name').textContent==='ui/components'&&!hierarchyGroup('/work/app/src/ui/components')),'chip opens content below, nested chip compressed');
 assert(await page.evaluate(()=>hierarchyRail('/work/app').getBoundingClientRect().bottom<=hierarchyGroup('/work/app/src').getBoundingClientRect().top),'detail below entire rail');
 await page.locator('.folder-board').screenshot({path:'.agent-logs/2026-11-05--folder-hierarchy-review/artifacts/chips-detail.png'});
 await page.evaluate(()=>hierarchyChip('/work/app/src/ui/components').click());
 assert(await page.locator('.folder-detail').count()===2,'nested selection opens');
 await page.evaluate(()=>hierarchyChip('/work/app/tests').click());
 assert(await page.evaluate(()=>hierarchyGroup('/work/app/tests')&&!hierarchyGroup('/work/app/src')&&!hierarchyChip('/work/app/src/ui/components')&&document.querySelectorAll('.folder-detail').length===1),'sibling switch excludes old subtree from DOM');
 assert(await page.evaluate(positions=>positions.every(p=>{const r=document.querySelector('[data-focus-key="'+p.key+'"]')?.getBoundingClientRect();return r&&r.x===p.x&&r.y===p.y}),positions),'chip positions stay fixed');
 await page.evaluate(()=>hierarchyChip('/work/app/tests').click());assert(await page.locator('.folder-detail').count()===0,'same chip closes');
 await page.evaluate(()=>hierarchyChip('/work/app/tests').focus());await page.keyboard.press('Enter');
 assert(await page.evaluate(()=>hierarchyGroup('/work/app/tests')&&document.activeElement===hierarchyChip('/work/app/tests')),'keyboard activation preserves chip focus');
 await page.evaluate(()=>{hierarchyUpdate();hierarchyGroup('/work/app').querySelector('.folder-toggle').click()});
 assert(await page.locator('.folder-chip-row').count()===0,'parent collapse excludes chips');
 await page.evaluate(()=>hierarchyGroup('/work/app').querySelector('.folder-toggle').click());
 assert(await page.evaluate(()=>!!hierarchyGroup('/work/app/tests')),'selection remembered after parent reopen and update');
 await page.evaluate(()=>hierarchyGroup('/work/app/tests').querySelector('.folder-toggle').click());
 assert(await page.evaluate(()=>!hierarchyGroup('/work/app/tests')&&document.activeElement!==document.body),'detail close retains connected focus');
 await page.evaluate(()=>hierarchyChip('/work/app/src').click());
 assert(await page.evaluate(()=>!!hierarchyGroup('/work/app/src/ui/components')),'nested selection remembered across sibling switch');
 await page.locator('.folder-detail .folder-task[data-status=completed]').click();
 assert(await page.locator('#sessions .session').count()===1,'nested journal');await page.keyboard.press('Escape');
 await page.evaluate(()=>folderBoard.select('codex'));
 assert(await page.evaluate(()=>!!hierarchyGroup('/work/app/src')&&hierarchyGroup('/work/app/src').dataset.depth==='0'&&!hierarchyGroup('/work/app')),'provider filter promotes root');
 await page.evaluate(()=>folderBoard.select('codex'));
 await page.waitForTimeout(450);
 const reparent=await page.evaluate(()=>{
  hierarchyGroup('/work/app/src').querySelector('.folder-toggle').focus();hierarchyRows=hierarchyRows.filter(r=>r.session_id!=='root');hierarchyUpdate();
  const ghost=document.querySelector('.folder-exit-layer');return {depth:hierarchyGroup('/work/app/src').dataset.depth,focus:document.activeElement.dataset.focusKey,safe:ghost?.inert&&ghost.getAttribute('aria-hidden')==='true'&&!ghost.querySelector('.folder-task,[data-focus-key]'),durations:document.getAnimations().filter(a=>a.id.startsWith('folder-')).map(a=>a.effect.getTiming().duration)};
 });
 assert(reparent.depth==='0'&&reparent.focus==='folder:/work/app/src'&&reparent.safe&&reparent.durations.every(n=>n===400),'promotion preserves focus with safe 400ms exit');
 await page.waitForTimeout(450);
 await page.evaluate(()=>{hierarchyRows=[{provider:'codex',session_id:'manyroot',cwd:'/many',title:'여러 하위 폴더',status:'running'},...Array.from({length:25},(_,i)=>({provider:'codex',session_id:'many'+i,cwd:'/many/아주긴하위폴더이름'+String(i).padStart(2,'0'),title:'하위 작업',status:'waiting_input'}))];hierarchyUpdate()});
 await page.waitForTimeout(450);
 const overflow=await page.evaluate(()=>{const row=hierarchyRail('/many'),more=row.querySelector('.folder-chip-more'),hidden=row.querySelectorAll('.folder-chip[hidden]').length;return {height:row.clientHeight,hidden,label:more.textContent,more:!more.hidden,count:document.querySelectorAll('.folder-task').length}});
 assert(overflow.height<=52&&overflow.hidden>0&&overflow.label==='+'+overflow.hidden+'개'&&overflow.more&&overflow.count===0,'two-line rail and exact hidden count');
 await page.locator('.folder-chip-more:visible').click();
 assert(await page.evaluate(()=>!hierarchyRail('/many').querySelector('.folder-chip[hidden]')&&hierarchyRail('/many').clientHeight>52),'more reveals all chips');
 await page.evaluate(()=>[...hierarchyRail('/many').querySelectorAll('.folder-chip')].at(-1).click());
 assert(await page.locator('.folder-detail').count()===1,'overflow chip opens content');
 await page.locator('.folder-chip-more:visible').click();
 assert(await page.evaluate(()=>hierarchyRail('/many').clientHeight<=52&&document.querySelectorAll('.folder-detail').length===1),'collapse rail preserves selected content');
 await page.evaluate(()=>[...hierarchyRail('/many').querySelectorAll('.folder-chip:not([hidden])')].at(-1).focus());
 await page.setViewportSize({width:320,height:1000});
 await page.waitForFunction(()=>hierarchyRail('/many').clientHeight<=52&&document.activeElement.classList.contains('folder-chip-more'));
 await page.setViewportSize({width:1280,height:1000});
 // A selected folder with many rows keeps scroll position during updates above it.
 await page.evaluate(()=>{hierarchyRows=[{provider:'codex',session_id:'scrollroot',cwd:'/scroll',title:'루트',status:'running'},...Array.from({length:35},(_,i)=>({provider:'codex',session_id:'scroll'+i,cwd:'/scroll/src',title:String(i).padStart(2,'0')+' 긴 작업명',status:'waiting_input'}))];hierarchyUpdate();hierarchyChip('/scroll/src').click()});
 await page.waitForTimeout(450);
 const anchor=await page.evaluate(()=>{const list=document.querySelector('.folder-list');list.scrollTop=350;const top=list.getBoundingClientRect().top,node=[...list.querySelectorAll('.folder-task')].find(e=>e.getBoundingClientRect().top>=top);node.focus({preventScroll:true});return {key:node.dataset.focusKey,top:node.getBoundingClientRect().top}});
 await page.evaluate(()=>{hierarchyRows.push({provider:'codex',session_id:'sibling',cwd:'/scroll/docs',title:'문서',status:'waiting_input'});hierarchyUpdate()});await page.waitForTimeout(450);
 assert(await page.evaluate(a=>{const node=[...document.querySelectorAll('.folder-task')].find(e=>e.dataset.focusKey===a.key);return Math.abs(node.getBoundingClientRect().top-a.top)<1&&node===document.activeElement},anchor),'chip update preserves reading anchor and focus');
 await page.evaluate(()=>{document.querySelector('.folder-list').scrollTop=0;hierarchyChip('/scroll/docs').focus();hierarchyRows=hierarchyRows.filter(r=>r.session_id!=='sibling');hierarchyUpdate()});
 assert(await page.evaluate(()=>{const ghost=document.querySelector('.folder-exit-layer');return !hierarchyChip('/scroll/docs')&&document.activeElement.isConnected&&document.activeElement!==document.body&&ghost?.inert&&!ghost.querySelector('[data-focus-key],.folder-chip')}),'deleted chip has safe ghost and connected focus');
 await page.evaluate(()=>{hierarchyRows.push({provider:'codex',session_id:'rapid-chip',cwd:'/scroll/new',title:'빠른 갱신',status:'running'});hierarchyUpdate();for(const a of document.getAnimations().filter(a=>a.id.startsWith('folder-'))){a.pause();a.currentTime=120;}hierarchyRows=hierarchyRows.filter(r=>r.session_id!=='rapid-chip');hierarchyUpdate()});
 assert(await page.locator('.folder-exit-layer').count()<=1,'rapid chip update keeps at most one exit layer');
 await page.waitForTimeout(450);
 await page.evaluate(()=>{hierarchyRows=[{provider:'claude',session_id:'expiring',cwd:'/expiry',title:'완료 부모',status:'completed',completed_at:Date.now()/1000-1799},{provider:'codex',session_id:'survivor',cwd:'/expiry/src',title:'진행 자식',status:'running'}];hierarchyUpdate();hierarchyUpdate(Date.now()/1000+2)});
 assert(await page.evaluate(()=>!hierarchyGroup('/expiry')&&hierarchyGroup('/expiry/src').dataset.depth==='0'),'expiry promotes hidden child');
 await page.evaluate(()=>{
  hierarchyRows=[{provider:'codex',session_id:'layout-root',cwd:'/project',title:'현황판 폴더 UI 개선',status:'running'},...Array.from({length:14},(_,i)=>({provider:'codex',session_id:'layout'+i,cwd:'/project/'+['src','tests','docs','scripts','assets','config','긴폴더이름을확인하는작업경로',...Array.from({length:7},(_,j)=>'module-'+j)][i],title:'아주 긴 작업명으로 계층 목록의 가로 넘침과 작업명 배치를 확인합니다',status:i%2?'waiting_input':'background'})),...Array.from({length:18},(_,i)=>({provider:'codex',session_id:'src'+i,cwd:'/project/src',title:'아주 긴 작업명을 가진 소스 개선 작업 '+i,status:'waiting_input'})),{provider:'claude',session_id:'nested',cwd:'/project/src/ui/components',title:'중첩 작업',status:'running'}];hierarchyUpdate();hierarchyChip('/project/src').click();
 });await page.waitForTimeout(450);
 const sizes=[];
 for(const before of baseline){
  await page.setViewportSize({width:before.width,height:1000});
  await page.waitForFunction(()=>hierarchyRail('/project').clientHeight<=52);
  const current=await page.evaluate(({theme,system,width})=>{
   document.documentElement.dataset.theme=theme;document.querySelector('.integrated-sidebar').classList.toggle('without-system',!system);
   const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
   const list=document.querySelector('.folder-list');list.scrollTop=0;
   return {theme,system,width,panel:rect('.workshop-panel'),board:rect('.folder-board'),overflow:document.documentElement.scrollWidth>innerWidth||list.scrollWidth>list.clientWidth,scroll:list.scrollHeight>list.clientHeight,states:[...document.querySelectorAll('.folder-task-state')].every(e=>getComputedStyle(e).whiteSpace==='nowrap'&&e.getBoundingClientRect().width===68),rowHeight:document.querySelector('.folder-task').getBoundingClientRect().height};
  },before);
  assert(JSON.stringify(before.panel)===JSON.stringify(current.panel)&&JSON.stringify(before.board)===JSON.stringify(current.board),'baseline geometry '+JSON.stringify(before));
  assert(!current.overflow&&current.scroll&&current.states,'overflow, scroll, status '+before.width);
  assert(await page.evaluate(()=>hierarchyRail('/project').clientHeight<=52),'two rows after resize '+before.width);
  assert(current.rowHeight<=(before.width<=420?124:106),'density '+before.width);
  sizes.push(current);
  if(before.system)await page.screenshot({path:'.agent-logs/2026-11-05--folder-hierarchy-review/artifacts/chips-'+before.theme+'-'+before.width+'.png'});
 }
 assert(!errors.length,errors.join('\n'));
 return {passed:true,checks:'chip defaults, stable rail, sibling switch, nested memory, parent collapse, more, keyboard, counts, promotion, journal, expiry, scroll/focus, 400ms exit, 16 baseline geometries',overflow,sizes,errors};
}
const code='async page => ('+suite.toString()+')(page,'+JSON.stringify(baseline)+')';
const r=spawnSync('playwright-cli',['-s=hierarchy','run-code',code],{encoding:'utf8',maxBuffer:1024*1024});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error/.test(r.stdout)?1:0));
