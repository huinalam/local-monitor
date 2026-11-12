const {spawnSync}=require('node:child_process');
async function suite(page){
 const assert=(v,m)=>{if(!v)throw Error(m)},errors=[];page.on('pageerror',e=>errors.push(e.message));
 const now=Date.now()/1000;let code=61,phase='day',requests=0,fail=false;
 const weather=()=>({timezone:'Asia/Seoul',current:{time:Date.now()/1000,temperature_2m:12,weather_code:code,is_day:phase==='night'?0:1},daily:{sunrise:[phase==='dawn'?now+600:now-14400],sunset:[phase==='dusk'?now+600:phase==='night'?now-3600:now+14400]}});
 await page.addInitScript(()=>{window.__geoCalls=0;navigator.geolocation.getCurrentPosition=()=>{window.__geoCalls++};window.EventSource=class{addEventListener(){}close(){}};window.Notification=class{static permission='denied'};});
 await page.route('**/api.open-meteo.com/**',r=>{requests++;return fail?r.abort():r.fulfill({json:weather()})});
 await page.route('**/api/state',r=>r.fulfill({json:{instance:'weather-fixture',seq:0,server_time:Date.now()/1000,snapshot:{at:Date.now()/1000,errors:[],sessions:['codex','claude','antigravity'].map(provider=>({provider,session_id:provider,status:'running',title:'Travel',cwd:'/fixture'}))},events:[],usage:[],collector_error:false,completion_window:{schema:1,seconds:600,entries:[]}}}));
 await page.route('**/api/diagnostics**',r=>r.fulfill({json:{ok:true}}));
 await page.goto('http://127.0.0.1:3012');
 const reload=async()=>{await page.evaluate(()=>{localStorage.removeItem('lm-weather-cache');localStorage.setItem('lm-theme','light')});await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.journeyWeather!=='unknown');};
 await reload();assert(await page.locator('#weather-chip').isVisible(),'weather across themes');assert(await page.evaluate(()=>__geoCalls)===0,'no location request');
 const initialRequests=requests;
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.dispatchEvent(new Event('themechange'))});
 assert(requests===initialRequests,'theme reuses weather fetch');
 await page.locator('.settings').evaluate(e=>e.open=true);await page.locator('#weather-city').selectOption('busan');
 await page.waitForFunction(()=>document.querySelector('#weather-chip').textContent.includes('부산'));
 assert(requests===initialRequests+1,'location shares single fetch loop');await page.locator('.settings').evaluate(e=>e.open=false);
 for(const [weatherCode,kind] of [[0,'clear'],[2,'partly'],[3,'cloudy'],[45,'fog'],[61,'rain'],[71,'snow'],[95,'storm']]){
  code=weatherCode;await reload();assert(await page.evaluate(()=>document.documentElement.dataset.journeyWeather)===kind,'classification '+kind);
  for(const sky of ['dawn','day','dusk','night']){
   await page.evaluate(s=>document.documentElement.dataset.sky=s,sky);
   assert(await page.locator('[data-workshop-provider=codex]').getAttribute('data-gait')==='walk','weather preserves gait');
   if(sky==='night')assert(await page.locator('.journey-hp-text').first().evaluate(e=>getComputedStyle(e).color)==='rgb(238, 243, 250)','night HP contrast');
   if(sky==='night'||sky==='dusk'||kind==='fog')assert(await page.locator('.ws-lantern').first().evaluate(e=>getComputedStyle(e).display)!=='none','lantern');
   await page.setViewportSize({width:390,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow');
  }
  await page.setViewportSize({width:1024,height:900});
  await page.locator('.workshop-panel').screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/weather-'+kind+'-night.png'});
 }
 for(const sky of ['dawn','day','dusk','night']){phase=sky;code=0;await reload();assert(await page.evaluate(()=>document.documentElement.dataset.sky)===sky,'solar phase '+sky);assert(await page.evaluate(()=>document.documentElement.dataset.orbitBody)===(sky==='night'?'moon':'sun'),'orb body');await page.locator('.workshop-panel').screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/weather-clear-'+sky+'.png'})}
 await page.evaluate(()=>{const e=document.querySelector('[data-workshop-provider=claude]');e.dataset.pose='sleeping';e.dataset.gait='rest'});assert(await page.locator('[data-workshop-provider=claude] .ws-blanket').evaluate(e=>getComputedStyle(e).display)!=='none','night rest blanket');
 code=61;phase='day';await reload();
 const clouds=await page.evaluate(()=>{
  const grid=document.querySelector('.workshop-grid');grid.classList.remove('journey-moving');
  document.querySelectorAll('.workshop-room').forEach(e=>{e.dataset.pose='sleeping';e.dataset.gait='rest'});
  return [...document.querySelectorAll('.journey-cloud')].map(e=>{const a=e.getAnimations()[0];a.pause();a.currentTime=0;const first=getComputedStyle(e).transform;a.currentTime=10000;const next=getComputedStyle(e).transform;const duration=a.effect.getTiming().duration;a.play();return {first,next,duration,state:getComputedStyle(e).animationPlayState}});
 });
 assert(clouds.length===7&&clouds.every(c=>c.first!==c.next&&c.state==='running'),'clouds move while tasks rest');
 assert(new Set(clouds.map(c=>c.duration)).size===7,'independent cloud speeds');
 const orbit=await page.evaluate(()=>({x:parseFloat(document.documentElement.style.getPropertyValue('--journey-orb-x')),y:parseFloat(document.documentElement.style.getPropertyValue('--journey-orb-y'))}));
 assert(orbit.x>=8&&orbit.x<=92&&orbit.y>=10&&orbit.y<=32,'orb stays in sky');

 await page.emulateMedia({reducedMotion:'reduce'});assert(await page.locator('.journey-precipitation').evaluate(e=>getComputedStyle(e).animationName)==='none','reduced weather motion');assert(await page.locator('.journey-cloud').first().evaluate(e=>getComputedStyle(e).animationName)==='none','reduced clouds');assert(await page.locator('.journey-orb').evaluate(e=>getComputedStyle(e).transitionDuration)==='0s','reduced orbit');await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))});assert(await page.locator('.journey-precipitation').evaluate(e=>getComputedStyle(e).animationPlayState)==='paused','hidden weather pause');assert(await page.locator('.journey-cloud').first().evaluate(e=>getComputedStyle(e).animationPlayState)==='paused','hidden clouds');
 await page.evaluate(()=>{const cached=JSON.parse(localStorage.getItem('lm-weather-cache'));cached.sample.at=Date.now()/1000-3700;cached.sample.received=Date.now()/1000;localStorage.setItem('lm-weather-cache',JSON.stringify(cached))});const before=requests;await page.reload();assert(await page.evaluate(()=>document.documentElement.dataset.journeyWeather)==='unknown','stale weather neutral');assert(requests===before,'cache avoids duplicate request');
 fail=true;await page.evaluate(()=>localStorage.removeItem('lm-weather-cache'));await page.reload();await page.waitForFunction(()=>document.querySelector('#weather-status').textContent.includes('갱신 실패'));assert(await page.evaluate(()=>document.documentElement.dataset.journeyWeather)==='unknown','failed weather neutral');
 assert(errors.length===0,'page errors '+errors.join(','));return {passed:true,checks:'7 weathers x 4 skies, solar phases, all-theme weather, no geolocation, cached stale, failed request, reduced/hidden motion, mobile, unchanged gait',errors};
}
const r=spawnSync('playwright-cli',['-s=weather-journey','run-code',suite.toString()],{encoding:'utf8',maxBuffer:1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error/.test(r.stdout)?1:0));
