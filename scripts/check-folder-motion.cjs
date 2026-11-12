const {spawnSync}=require('node:child_process');
async function suite(page){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const assert=(v,m)=>{if(!v)throw Error(m)};
 await page.addInitScript(()=>window.EventSource=class{addEventListener(){}close(){}});
 const now=Date.now()/1000,initial=[{provider:'codex',session_id:'a',cwd:'/work/alpha',title:'A: 진행 중인 작업',status:'waiting_input'},{provider:'claude',session_id:'c',cwd:'/work/alpha',title:'C: 검토 작업',status:'waiting_input'},{provider:'antigravity',session_id:'z',cwd:'/work/beta',title:'Z: 다른 폴더 작업',status:'waiting_input'}];
 await page.route('**/api/state',r=>r.fulfill({json:{instance:'motion',seq:0,server_time:now,snapshot:{at:now,sessions:initial,errors:[]},events:[],usage:[],collector_error:false}}));
 await page.setViewportSize({width:1280,height:900});await page.goto('http://127.0.0.1:3010/');await page.waitForSelector('.folder-task');
 await page.evaluate(()=>{
  window.motionRows=data.snapshot.sessions;window.motionUpdate=()=>{const now=Date.now()/1000;serverClock.observe(now);applyState({...data,server_time:now,snapshot:{at:now,errors:[],sessions:motionRows}})};
  window.layoutAnimations=()=>document.getAnimations().filter(a=>a.id.startsWith('folder-'));
  window.taskNode=id=>[...document.querySelectorAll('.folder-task')].find(e=>e.dataset.focusKey==='task:'+JSON.stringify([motionRows.find(r=>r.session_id===id)?.provider||'codex',id]));
 });
 assert(await page.evaluate(()=>layoutAnimations().length)===0,'initial load has no transition');
 const inserted=await page.evaluate(()=>{motionRows.push({provider:'codex',session_id:'b',cwd:'/work/alpha',title:'B: 새 작업',status:'waiting_input'});motionUpdate();return layoutAnimations().map(a=>a.id)});
 assert(inserted.includes('folder-enter')&&inserted.includes('folder-move'),'insert and sibling movement');
 await page.waitForTimeout(460);
 const removed=await page.evaluate(()=>{motionRows=motionRows.filter(r=>r.session_id!=='b');motionUpdate();const ghost=document.querySelector('.folder-exit-layer');return {ids:layoutAnimations().map(a=>a.id),count:document.querySelectorAll('.folder-task').length,inert:ghost?.inert,hidden:ghost?.getAttribute('aria-hidden'),fakeTasks:ghost?.querySelectorAll('.folder-task,[data-focus-key],[id]').length}});
 assert(removed.ids.includes('folder-exit')&&removed.count===3&&removed.inert&&removed.hidden==='true'&&removed.fakeTasks===0,'removed row is only an inert ghost');
 await page.evaluate(()=>{for(const a of layoutAnimations()){a.pause();a.currentTime=120}});
 await page.screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/folder-motion-exit.png'});
 await page.evaluate(()=>{for(const a of layoutAnimations())a.play()});
 await page.waitForTimeout(460);assert(await page.locator('.folder-exit-layer').count()===0,'exit cleanup');
 const group=await page.evaluate(()=>{motionRows=motionRows.filter(r=>r.cwd!=='/work/beta');motionUpdate();return {ghosts:document.querySelector('.folder-exit-layer')?.childElementCount,groups:document.querySelectorAll('.folder-group').length}});
 assert(group.ghosts===1&&group.groups===1,'last row removes folder as one ghost');await page.waitForTimeout(460);
 const freshGroup=await page.evaluate(()=>{motionRows.push({provider:'antigravity',session_id:'z',cwd:'/work/beta',title:'Z: 새 폴더',status:'waiting_input'});motionUpdate();return layoutAnimations().filter(a=>a.id==='folder-enter').map(a=>a.effect.target.className)});
 assert(freshGroup.length===1&&freshGroup[0]==='folder-group','folder enters as one unit');await page.waitForTimeout(460);
 const reordered=await page.evaluate(()=>{motionRows=motionRows.map(r=>r.cwd==='/work/alpha'?{...r,status:'completed',completed_at:Date.now()/1000}:r);motionRows.push({provider:'codex',session_id:'count-only',cwd:'/work/beta',title:'진행 수',status:'running'});motionUpdate();return layoutAnimations().map(a=>a.id)});
 assert(reordered.includes('folder-move')&&!reordered.includes('folder-enter')&&!reordered.includes('folder-exit'),'reorder keeps identities');await page.waitForTimeout(460);
 const rapid=await page.evaluate(()=>{
  motionRows.push({provider:'codex',session_id:'new',cwd:'/work/aaa',title:'새 폴더',status:'waiting_input'});motionUpdate();
  for(const a of layoutAnimations()){a.pause();a.currentTime=200;}
  const before=taskNode('z').getBoundingClientRect().top;
  motionRows=motionRows.filter(r=>r.session_id!=='a');motionUpdate();
  return {before,after:taskNode('z').getBoundingClientRect().top,layers:document.querySelectorAll('.folder-exit-layer').length};
 });assert(Math.abs(rapid.before-rapid.after)<1&&rapid.layers<=1,'rapid update continues current visual position');
 await page.waitForTimeout(460);
 await page.evaluate(()=>{motionRows=Array.from({length:35},(_,i)=>({provider:'codex',session_id:'row'+i,cwd:'/work/long-list',title:String(i).padStart(2,'0')+' 작업',status:'waiting_input'}));motionUpdate()});await page.waitForTimeout(460);
 await page.locator('.folder-list').evaluate(e=>e.scrollTop=310);
 const anchor=await page.evaluate(()=>{const list=document.querySelector('.folder-list'),top=list.getBoundingClientRect().top;const e=[...list.querySelectorAll('.folder-task')].find(e=>e.getBoundingClientRect().bottom>top);const key=e.dataset.focusKey,before=e.getBoundingClientRect().top,scroll=list.scrollTop;
  motionRows.unshift({provider:'codex',session_id:'above',cwd:'/work/long-list',title:'00 앞에 추가',status:'waiting_input'});motionUpdate();const after=[...list.querySelectorAll('.folder-task')].find(e=>e.dataset.focusKey===key).getBoundingClientRect().top;return {before,after,scroll,newScroll:list.scrollTop};});
 assert(Math.abs(anchor.before-anchor.after)<1&&anchor.newScroll>anchor.scroll,'reading anchor preserved for insertion above viewport');
 const focus=await page.evaluate(()=>{const e=taskNode('row12');e.focus({preventScroll:true});motionRows=motionRows.filter(r=>r.session_id!=='row12');motionUpdate();return {key:document.activeElement.dataset.focusKey,connected:document.activeElement.isConnected}});
 assert(focus.connected&&focus.key?.includes('row13'),'removed focus moves to adjacent task');await page.waitForTimeout(460);
 await page.emulateMedia({reducedMotion:'reduce'});
 assert(await page.evaluate(()=>{motionRows=motionRows.slice(0,-1);motionUpdate();return !layoutAnimations().length&&!document.querySelector('.folder-exit-layer')}),'reduced motion updates immediately');await page.emulateMedia({reducedMotion:'no-preference'});
 assert(await page.evaluate(()=>{motionRows=motionRows.slice(0,-1);motionUpdate();folderBoard.render(data,Date.now()/1000,true);return !layoutAnimations().length&&!document.querySelector('.folder-exit-layer')}),'offline cancels effects');
 await page.evaluate(()=>motionUpdate());
 assert(await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));motionRows=motionRows.slice(0,-1);motionUpdate();const stopped=!layoutAnimations().length;delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));return stopped;}),'hidden tab has no effects');
 await page.locator('.folder-list').evaluate(e=>e.scrollTop=0);
 const scrolling=await page.evaluate(()=>{motionRows=motionRows.slice(1);motionUpdate();const started=layoutAnimations().length;document.querySelector('.folder-list').dispatchEvent(new WheelEvent('wheel'));return {started,stopped:layoutAnimations().length}});assert(scrolling.started>0&&scrolling.stopped===0,'user scrolling cancels transient effects');
 assert(await page.evaluate(()=>{folderBoard.reset();motionUpdate();return !layoutAnimations().length}),'reset has no entrance effect');
 for(const width of [320,390,768,1280]){
  await page.setViewportSize({width,height:900});await page.evaluate(()=>{motionRows=motionRows.slice(1);motionUpdate()});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'viewport overflow '+width);
  assert(await page.locator('.workshop-panel').evaluate(e=>e.getBoundingClientRect().height)===(width<760?695:461),'panel size '+width);
  await page.waitForTimeout(460);
 }
 await page.evaluate(()=>{motionRows.unshift({provider:'claude',session_id:'preview',cwd:'/work/aaa-preview',title:'새 폴더가 나타나는 모습',status:'waiting_input'});motionUpdate();for(const a of layoutAnimations()){a.pause();a.currentTime=200;}});
 await page.screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/folder-motion-midpoint.png'});
 await page.evaluate(()=>{for(const a of layoutAnimations())a.finish()});
 await page.screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/folder-motion-settled.png'});
 assert(!errors.length,errors.join('\n'));return {passed:true,checks:'initial, insert, delete, group exit, group entry, reorder, rapid interruption, scroll anchor, focus removal, reduced motion, offline, hidden, scrolling, reset, responsive geometry',errors};
}
const r=spawnSync('playwright-cli',['-s=motion','run-code',suite.toString()],{encoding:'utf8',maxBuffer:1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error/.test(r.stdout)?1:0));
