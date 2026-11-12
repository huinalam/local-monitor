const {spawnSync}=require('node:child_process');
async function suite(page){
 const assert=(v,m)=>{if(!v)throw Error(m)},errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.EventSource=class{addEventListener(){}close(){}}});
 await page.route('**/api/state',async r=>r.fulfill({json:{instance:'preview',seq:0,server_time:Date.now()/1000,snapshot:{at:Date.now()/1000,sessions:await page.evaluate(()=>window.__rows||[]),errors:[]},events:[],usage:[],collector_error:false}}));
 await page.goto('http://127.0.0.1:3010');
 await page.waitForFunction(()=>typeof data!=='undefined'&&data?.instance==='preview');
 await page.evaluate(()=>{window.__rows=[];window.__show=(rows)=>{window.__rows=rows;const now=Date.now()/1000;serverClock.observe(now);applyState({...data,server_time:now,snapshot:{at:now,sessions:rows,errors:[]},events:[],collector_error:false})}; const now=Date.now()/1000;__show(Array.from({length:5},(_,i)=>({provider:'codex',cwd:'/fixture',session_id:'preview'+i,title:i===0?'<img src=x onerror=alert(1)> 긴 작업 이름을 안전하게 보여주는 테스트':`작업 ${i}`,status:'completed',completed_at:now-i*300,observed_at:now})).reverse())});
 const room=page.locator('[data-workshop-provider=codex]');
 assert(await room.locator('.workshop-recent-row:visible').count()===3,'three visible');
 assert((await room.locator('.workshop-recent-title').allTextContents())[0].startsWith('<img'),'newest and safe title');
 assert(await room.locator('.workshop-recent-title img').count()===0,'no html injection');
 assert(await room.locator('.workshop-recent-more').textContent()==='+2개 더 보기','more count');
 const angle=await room.locator('.workshop-recent-time').nth(2).evaluate(e=>parseFloat(e.style.getPropertyValue('--elapsed-angle')));assert(angle>=120&&angle<122,'10 minute task has one third elapsed pie');
 await room.locator('.workshop-recent-more').click();assert(await page.locator('#sessions .session').count()===5,'journal all five '+JSON.stringify(await page.evaluate(()=>({n:data.snapshot.sessions.length,r:window.__rows?.length,e:workshopModel.entries.length}))));await page.keyboard.press('Escape');
 await page.evaluate(()=>__show(__rows.map(r=>r.session_id==='preview0'?{...r,status:'running'}:r)));
 assert(await room.locator('.journey-done-badge').getAttribute('data-count')==='4','resume count');assert(!(await room.locator('.workshop-recent-list').textContent()).includes('<img'),'resume removed');
 await page.evaluate(()=>__show(__rows.map(r=>r.session_id==='preview1'?{...r,completed_at:Date.now()/1000-1799.5}:r)));
 await page.waitForFunction(()=>document.querySelector('[data-workshop-provider=codex] .journey-done-badge').dataset.count==='3');
 assert(await room.locator('.workshop-recent-more').isHidden(),'expiry removes more');
 await page.evaluate(()=>__show(__rows.filter(r=>r.session_id!=='preview2')));assert(await room.locator('.workshop-recent-row:visible').count()===2,'removed session removed');
 await page.evaluate(()=>{__show(__rows.map(r=>r.session_id==='preview0'?{...r,status:'completed',completed_at:Date.now()/1000}:r));transportError(Error('offline'));transportError(Error('offline'))});
 assert((await room.locator('.workshop-recent-time:visible').evaluateAll(es=>es.map(e=>e.getAttribute('aria-label')))).every(t=>t.startsWith('이전 관측값')),'offline explicit');
 await page.evaluate(()=>__show(__rows));
 for(const width of [320,390,1024]){
  await page.setViewportSize({width,height:900});
  const positions=await page.locator('.workshop-room').evaluateAll(es=>es.map(e=>{const h=e.querySelector('.workshop-name').getBoundingClientRect(),hp=e.querySelector('.journey-hp').getBoundingClientRect(),scene=e.querySelector('.workshop-scene').getBoundingClientRect();return h.bottom<=hp.top+1&&h.top>=scene.top-1}));
  assert(positions.every(Boolean),'name above HP and not clipped '+width);
  assert(await page.locator('.workshop-metrics').count()===0,'no duplicate metrics');
  assert(await page.locator('.workshop-room').evaluateAll(es=>es.every(e=>{const t=e.querySelector('.journey-traveller'),r=e.querySelector('.workshop-recent');return t.nextElementSibling===r&&r.getBoundingClientRect().top-t.getBoundingClientRect().bottom<=8})), 'preview directly beneath traveller');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow '+width);
  await page.locator('.workshop-panel').screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/task-preview-'+width+'.png'});
 }
 await page.evaluate(()=>__show([]));assert(await room.locator('.workshop-recent-empty').textContent()==='최근 30분 완료 없음','empty');
 assert(!errors.length,errors.join('\n'));return {passed:true,errors,checks:'3-limit/order/more/journal/safe-title/resume/expiry/removal/recomplete/offline/mobile/name-placement'};
}
const r=spawnSync('playwright-cli',['-s=preview-tasks','run-code',suite.toString()],{encoding:'utf8',maxBuffer:1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error|Error:|TimeoutError/.test(r.stdout||'')?1:0));
