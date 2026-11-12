const {spawnSync}=require('node:child_process');
async function suite(page){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const assert=(v,m)=>{if(!v)throw Error(m)};
 await page.addInitScript(()=>window.EventSource=class{addEventListener(){}close(){}});
 const now=Date.now()/1000;
 const usage=['codex','claude','antigravity'].map(provider=>({provider,status:'ok',observed_at:now,windows:[{id:'weekly',group:'전체',label:'주간',remaining_percent:70,resets_at:now+86400*4,daily:{status:'ok',used:5,recommended:20,available:15,gauge_baseline:75,gauge_used:5}},{id:'short',group:'전체',label:'5시간',remaining_percent:85,resets_at:now+3600}]}));
 await page.route('**/api/state',r=>r.fulfill({json:{instance:'integrated',seq:0,server_time:now,snapshot:{at:now,sessions:[],errors:[]},events:[],usage,collector_error:false}}));
 await page.route('**/api/usage/**',r=>r.fulfill({json:usage.find(row=>r.request().url().endsWith('/'+row.provider))||usage[0]}));
 await page.goto('http://127.0.0.1:3010/');await page.waitForSelector('.integrated-usage .usage-card');
 assert(await page.locator('.usage-section .usage-card').count()===0,'no top cards');
 assert(await page.locator('.integrated-usage .usage-card').count()===3,'three mounted cards');
 assert(await page.locator('.usage-recommendation').count()===3,'weekly recommendation retained');
 assert((await page.locator('.journey-hp').first().textContent()).includes('75'),'daily HP distinct from weekly 70');
 for(const width of [320,390,768,1280]){
  await page.setViewportSize({width,height:1000});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow '+width);
  assert(await page.locator('.integrated-usage .usage-card').first().evaluate(e=>e.scrollWidth<=e.clientWidth),'quota horizontal overflow '+width);
  assert(await page.locator('.workshop-room').evaluateAll(es=>es.every(e=>{const a=e.querySelector('.journey-hp-track').getBoundingClientRect(),b=e.querySelector('.usage-primary .usage-meter').getBoundingClientRect();return Math.abs(a.x-b.x)<1&&Math.abs(a.width-b.width)<1})),'aligned dual gauges '+width);
  assert(await page.locator('.workshop-panel').evaluate(e=>e.getBoundingClientRect().height)===(width<760?695:461),'preserved panel height '+width);
  assert(await page.locator('.usage-secondary:visible').count()===0,'secondary quotas in details');

  await page.screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/integrated-'+width+'.png'});
 }
 await page.locator('.integrated-usage .usage-card').first().focus();await page.keyboard.press('Enter');assert(await page.locator('#usage-dialog').evaluate(e=>e.open),'keyboard quota detail');await page.waitForSelector('.usage-detail-window');assert(await page.locator('.usage-detail-window').count()===2,'secondary quota preserved in detail');await page.keyboard.press('Escape');
 await page.locator('.journey-hp').first().click();assert(await page.locator('#usage-dialog').evaluate(e=>e.open),'HP detail');await page.keyboard.press('Escape');
 await page.locator('#system-chip').click();assert(await page.locator('#system-dialog').evaluate(e=>e.open),'system detail');await page.keyboard.press('Escape');
 await page.locator('.settings summary').click();await page.locator('#show-system').uncheck();assert(!await page.locator('#system-chip').isVisible(),'system off');await page.locator('#show-system').check();await page.locator('.settings summary').click();
 for(const theme of ['dark','rpg','night','real','cloud']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  assert(await page.locator('.usage-recommendation').first().isVisible(),'marker '+theme);
  assert(await page.locator('.journey-hp-text').first().evaluate(e=>getComputedStyle(e).color===getComputedStyle(e.closest('.journey-hp')).color),'HP text follows card theme '+theme);
  assert(await page.locator('.integrated-usage .usage-card').first().evaluate(e=>e.scrollWidth<=e.clientWidth),'theme overflow '+theme);
 }
 await page.screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/integrated-cloud.png'});
 await page.evaluate(()=>{const w=data.usage[0].windows[0];w.daily={...w.daily,used:25,available:-5};renderUsage(data.usage);renderWorkshop()});
 assert((await page.locator('[data-workshop-provider=codex] .journey-hp').textContent()).includes('+25% 초과'),'over-budget visible');
 await page.evaluate(()=>{data.usage[0].status='stale';data.usage[0].windows[0].stale=true;renderUsage(data.usage);renderWorkshop()});
 assert((await page.locator('[data-workshop-provider=codex] .journey-hp').textContent()).includes('확인 중'),'unknown daily HP');
 assert(await page.locator('[data-usage-provider=codex] .usage-foot.warning').isVisible(),'stale warning visible');
 await page.evaluate(()=>{data.usage[1]={provider:'claude',status:'unavailable',error:'auth_required',windows:[]};renderUsage(data.usage)});
 assert(await page.locator('[data-usage-provider=claude] .usage-login').count()===1,'login guidance retained');
 assert(!errors.length,errors.join('\n'));return {passed:true,checks:'quota placement, daily versus weekly, recommendation, 320/390/768/1280, keyboard/HP/system details, visibility toggle, five themes, auth error',errors};
}
const r=spawnSync('playwright-cli',['-s=integrated','run-code',suite.toString()],{encoding:'utf8',maxBuffer:1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error/.test(r.stdout)?1:0));
