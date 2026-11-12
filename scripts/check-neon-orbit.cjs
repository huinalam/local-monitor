const {spawnSync}=require('node:child_process');
async function suite(page){
 const baseline=BASELINE,dir='.agent-logs/2026-11-06--neon-orbit/artifacts';
 const assert=(v,m)=>{if(!v)throw Error(m)},errors=[];page.on('pageerror',e=>errors.push(e.message));
 let code=61,fail=false,requests=0;
 await page.addInitScript(()=>{window.EventSource=class{addEventListener(){}close(){}};window.Notification=class{static permission='denied'};});
 const now=Date.now()/1000,providers=['codex','claude','antigravity'];
 const usage=providers.map(provider=>({provider,status:'ok',observed_at:now,windows:[{id:'weekly',group:'전체',label:'주간',remaining_percent:70,resets_at:now+345600,daily:{status:'ok',used:5,recommended:20,available:15,gauge_baseline:75,gauge_used:5}},{id:'short',group:'전체',label:'5시간',remaining_percent:85,resets_at:now+3600}]}));
 const sessions=Array.from({length:24},(_,i)=>({provider:providers[i%3],session_id:'orbit-'+i,status:['running','background','waiting_input','completed'][i%4],title:['네온 오비트 테마 구성','날씨 효과와 조종석 상태 연결','아주 긴 작업명을 가진 레이아웃 회귀 확인 작업'][i%3],cwd:i<12?'/workspace/local-monitor/web':'/workspace/local-monitor/scripts',updated_at:now,completed_at:i%4===3?now-10:null}));
 await page.route('**/api.open-meteo.com/**',r=>{requests++;return fail?r.abort():r.fulfill({json:{timezone:'Asia/Seoul',current:{time:Date.now()/1000,temperature_2m:14,weather_code:code,is_day:0},daily:{sunrise:[],sunset:[]}}})});
 await page.route('**/api/state',r=>r.fulfill({json:{instance:'neon-fixture',seq:0,server_time:now,snapshot:{at:now,sessions,errors:[]},events:[],usage,collector_error:false,completion_window:{schema:1,seconds:600,entries:[]}}}));
 await page.route('**/api/usage/**',r=>r.fulfill({json:usage.find(u=>r.request().url().endsWith('/'+u.provider))||usage[0]}));
 await page.goto('http://127.0.0.1:3010');
 await page.evaluate(()=>localStorage.removeItem('lm-weather-cache'));await page.reload();
 await page.waitForSelector('.integrated-usage .usage-card');await page.waitForFunction(()=>document.documentElement.dataset.journeyWeather==='rain');
 const theme=async t=>{await page.locator('.settings').evaluate(e=>e.open=true);await page.selectOption('#theme',t);await page.locator('.settings').evaluate(e=>e.open=false)};
 const geometry=()=>page.evaluate(()=>{
  const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
  return {panel:rect('.workshop-panel'),room:rect('.workshop-room'),list:rect('.folder-board'),pageWidth:document.documentElement.scrollWidth,pageHeight:document.documentElement.scrollHeight};
 });
 const captured={};
 for(const width of [320,390,768,1280]){
  await page.setViewportSize({width,height:900});
  for(const system of [true,false]){
   await page.locator('#show-system').evaluate((e,v)=>{e.checked=v;e.dispatchEvent(new Event('change'))},system);
   for(const t of baseline?['light','dark']:['light','dark','orbit']){
    await theme(t);await page.waitForTimeout(100);
    const g=await geometry(),key=width+'-'+system+'-'+t;captured[key]=g;
    assert(g.pageWidth<=width,'horizontal overflow '+key);
    if(!baseline){const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('neon-baseline')));const b=(saved||captured)[width+'-'+system+'-'+(t==='orbit'?'dark':t)];assert(JSON.stringify(g)===JSON.stringify(b),'geometry '+key+' '+JSON.stringify({g,b}));}
    assert(await page.locator('.workshop-room').evaluateAll(es=>es.every(e=>{const a=e.querySelector('.journey-hp-track').getBoundingClientRect(),b=e.querySelector('.usage-primary .usage-meter').getBoundingClientRect();return Math.abs(a.x-b.x)<1&&Math.abs(a.width-b.width)<1})),'aligned gauges '+key);
    if(system&&t===(baseline?'dark':'orbit'))await page.screenshot({path:dir+'/'+(baseline?'before-':'orbit-')+width+'.png'});
   }
  }
 }
 if(baseline){await page.evaluate(g=>localStorage.setItem('neon-baseline',JSON.stringify(g)),captured);return {baseline:true,geometry:captured,errors};}
 await page.locator('#show-system').evaluate(e=>{e.checked=true;e.dispatchEvent(new Event('change'))});await page.setViewportSize({width:1280,height:900});await theme('orbit');await page.reload();
 assert(await page.locator('html').getAttribute('data-theme')==='orbit','persisted theme');
 assert((await page.locator('#weather-chip').textContent()).includes('비'),'header condition');
 const display=s=>page.locator(s).first().evaluate(e=>getComputedStyle(e).display);
 assert(await display('.orbit-craft')!=='none','cockpit visible');assert(await display('.ride-rig')==='none','original vehicle hidden');
 const count=requests;await theme('dark');assert(await display('.orbit-craft')==='none','other theme unchanged');await theme('orbit');assert(requests===count,'no duplicate weather fetch');
 for(const [value,kind] of [[0,'clear'],[2,'partly'],[3,'cloudy'],[45,'fog'],[61,'rain'],[71,'snow'],[95,'storm']]){
  code=value;await page.evaluate(()=>localStorage.removeItem('lm-weather-cache'));await page.reload();await page.waitForFunction(k=>document.documentElement.dataset.journeyWeather===k,kind);
  assert((await display('.orbit-droplets')!=='none')===['rain','storm'].includes(kind),'droplets '+kind);
  assert((await display('.orbit-frost')!=='none')===(kind==='snow'),'frost '+kind);
  await page.setViewportSize({width:320,height:900});assert((await geometry()).panel.y===40,'weather header keeps panel position '+kind);await page.setViewportSize({width:1280,height:900});
  for(const sky of ['day','night']){await page.evaluate(s=>document.documentElement.dataset.sky=s,sky);await page.locator('.workshop-panel').screenshot({path:dir+'/weather-'+kind+'-'+sky+'.png'});}
 }
 for(const pose of ['working','background','waiting','failed','sleeping','unknown']){
  await page.locator('[data-workshop-provider=codex]').evaluate((e,p)=>e.dataset.pose=p,pose);
  assert((await display('[data-workshop-provider=codex] .orbit-engine')!=='none')===['working','background'].includes(pose),'engine '+pose);
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 assert(await page.locator('.orbit-craft').first().evaluate(e=>getComputedStyle(e).animationName)==='none','reduced craft');
 assert(await page.locator('.journey-precipitation').first().evaluate(e=>getComputedStyle(e).animationName)==='none','reduced rain');await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))});
 assert(await page.locator('.orbit-craft').first().evaluate(e=>getComputedStyle(e).animationPlayState)==='paused','hidden craft');
 await page.evaluate(()=>{const c=JSON.parse(localStorage.getItem('lm-weather-cache'));c.sample.at=Date.now()/1000-3700;c.sample.received=Date.now()/1000;localStorage.setItem('lm-weather-cache',JSON.stringify(c))});await page.reload();assert(await page.locator('html').getAttribute('data-journey-weather')==='unknown','stale weather neutral');
 fail=true;await page.evaluate(()=>localStorage.removeItem('lm-weather-cache'));await page.reload();await page.waitForFunction(()=>document.querySelector('#weather-status').textContent.includes('갱신 실패'));assert(await page.locator('html').getAttribute('data-journey-weather')==='unknown','failed weather neutral');
 await page.setViewportSize({width:320,height:900});assert((await geometry()).panel.y===40,'unknown header keeps panel position');await page.setViewportSize({width:1280,height:900});
 fail=false;code=61;await page.evaluate(()=>localStorage.removeItem('lm-weather-cache'));await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.journeyWeather==='rain');
 await page.locator('.journey-hp').first().click();assert(await page.locator('#usage-dialog').evaluate(e=>e.open),'HP dialog');await page.keyboard.press('Escape');
 await page.locator('.workshop-scene').first().click();assert(await page.locator('.workshop-scene').first().getAttribute('aria-pressed')==='true','provider selection');
 await page.locator('.settings').evaluate(e=>e.open=true);await page.locator('#workshop-all').click();await page.locator('.settings').evaluate(e=>e.open=false);
 assert(await page.locator('.folder-task-state').evaluateAll(es=>es.every(e=>getComputedStyle(e).whiteSpace==='nowrap')),'single-line states');
 await page.screenshot({path:dir+'/neon-orbit-final.png'});
 assert(!errors.length,'page errors '+errors.join(','));return {passed:true,checks:'theme persistence/isolation, exact baseline geometry x4 widths x2 system settings x3 themes, weather x7 x2 skies, motion/state, stale/failure, dialogs/provider filter',errors};
}
const source=suite.toString().replace('BASELINE',String(process.argv.includes('--baseline')));
const r=spawnSync('playwright-cli',['-s=neon-orbit','run-code',source],{encoding:'utf8',maxBuffer:2*1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error/.test(r.stdout)?1:0));
