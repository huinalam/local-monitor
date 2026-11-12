const {spawnSync}=require('node:child_process');
async function suite(page){
 const errors=[],assert=(v,m)=>{if(!v)throw Error(m)};
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await page.goto('http://127.0.0.1:3012');await page.setViewportSize({width:1024,height:900});
 const clouds=await page.locator('.journey-cloud').evaluateAll(es=>es.map(e=>{
  const a=e.getAnimations()[0],timing=a.effect.getTiming(),style=getComputedStyle(e),land=e.closest('.journey-landscape').getBoundingClientRect();
  a.pause();a.currentTime=timing.delay+timing.duration+.01;const start=e.querySelector('svg').getBoundingClientRect();
  a.currentTime=timing.delay+2*timing.duration-.01;const end=e.querySelector('svg').getBoundingClientRect();
  a.currentTime=0;a.play();
  return {size:style.getPropertyValue('--cloud-size'),top:style.top,duration:timing.duration,delay:timing.delay,offscreen:start.left>=land.right-.1&&end.right<=land.left+.1};
 }));
 assert(clouds.length===7&&clouds.every(c=>c.offscreen),'loop resets outside visible landscape');
 for(const key of ['size','top','duration','delay'])assert(new Set(clouds.map(c=>c[key])).size===7,'varied '+key);
 assert(await page.locator('.journey-clouds').evaluateAll(es=>es.every(e=>getComputedStyle(e).backgroundImage==='none')),'no repeated cloud background');
 for(const [sky,weather] of [['day','clear'],['night','clear'],['day','rain']]){
  await page.evaluate(([s,w])=>{document.documentElement.dataset.sky=s;document.documentElement.dataset.journeyWeather=w},[sky,weather]);
  for(const width of [1024,320]){
   await page.setViewportSize({width,height:900});
   assert(await page.locator('.journey-cloud').evaluateAll(es=>es.filter(e=>getComputedStyle(e).display!=='none').length)===(width===320?5:7),'mobile density');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no overflow');
   await page.locator('.workshop-panel').screenshot({path:'.agent-logs/2026-10-26--little-workshop-design/artifacts/browser/natural-'+sky+'-'+weather+'-'+width+'.png'});
  }
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 const fixed=await page.locator('.journey-cloud').evaluateAll(es=>es.filter(e=>getComputedStyle(e).display!=='none').map(e=>({animation:getComputedStyle(e).animationName,left:e.querySelector('svg').getBoundingClientRect().left})));
 assert(fixed.every(e=>e.animation==='none')&&new Set(fixed.map(e=>e.left)).size===5,'reduced motion keeps scattered clouds');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>document.querySelector('.workshop-grid').classList.add('journey-stale'));
 assert(await page.locator('.journey-cloud').evaluateAll(es=>es.every(e=>getComputedStyle(e).animationPlayState==='paused')),'stale pauses clouds');
 assert(!errors.length,errors.join('\n'));return {passed:true,clouds,errors};
}
const r=spawnSync('playwright-cli',['-s=natural','run-code',suite.toString()],{encoding:'utf8',maxBuffer:1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||(/### Error|Error:|TimeoutError/.test(r.stdout||'')?1:0));
