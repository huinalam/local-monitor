const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('local_monitor/web/diagnostics.js','utf8');
function setup(saved=null,broken=false){
  let wall=2000000000000,mono=0,state={snapshot_age_s:2,stream:'open',warning:false,reason:'none',secret:'do-not-store',title:'private-title'};
  const savedKey='lm-connection-diagnostics-v1',store=new Map(saved?[[savedKey,saved]]:[]),timers=[],listeners={};
  const context={crypto:require('node:crypto').webcrypto,setTimeout:()=>1,clearTimeout:()=>{},window:{addEventListener:(e,f)=>listeners[e]=f},document:{visibilityState:'visible',getElementById:()=>null,addEventListener:(e,f)=>listeners[e]=f},navigator:{onLine:true},performance:{now:()=>mono},Date:class extends Date{static now(){return wall;}},localStorage:{getItem:k=>{if(broken)throw Error('blocked');return store.get(k)||null;},setItem:(k,v)=>{if(broken)throw Error('quota');store.set(k,v);},removeItem:k=>{if(broken)throw Error('blocked');store.delete(k);}},setInterval:f=>{timers.push(f);return 1;},clearInterval:()=>{},MutationObserver:class{observe(){}disconnect(){}}};
  vm.createContext(context);vm.runInContext(source,context);
  const logger=context.window.LocalMonitorDiagnostics.create(()=>state);
  return {logger,store,timers,listeners,state,advance:(ms,clock=ms)=>{wall+=clock;mono+=ms;},setState:s=>state=s};
}
{
  const s=setup();s.advance(10000);s.timers[0]();
  const report=s.logger.report();assert(report.records.some(x=>x.event==='sample'));assert(!JSON.stringify(report).includes('private'));assert(!JSON.stringify(report).includes('do-not-store'));
  for(let i=0;i<650;i++){s.advance(10000);s.logger.record('sample',{raw:'token'});}
  assert.equal(s.logger.report().records.length,600);
  const loaded=setup(s.store.get('lm-connection-diagnostics-v1'));assert.equal(loaded.logger.report().records.length,600);
  s.advance(86400001);assert.equal(s.logger.report().records.length,0);
}
{
  const s=setup();s.setState({warning:true,reason:'stale',snapshot_age_s:16,stream:'open',collector_error:false});s.advance(20);s.timers[0]();
  let r=s.logger.report().records;assert(r.some(x=>x.event==='warning'&&x.reason==='stale'&&x.snapshot_age_s===16));
  s.setState({warning:false,reason:'none',stream:'open'});s.advance(20);s.timers[0]();assert(s.logger.report().records.some(x=>x.event==='recovery'));
  s.logger.record('sse_error',{},true);s.logger.record('sse_error',{},true);assert.equal(s.logger.report().records.filter(x=>x.event==='sse_error').length,1);
  s.advance(10,30000);s.logger.record('sample');assert.equal(s.logger.report().records.at(-1).clock_delta_ms,29990);
  s.logger.clear();assert.equal(s.logger.report().records.length,0);
}
{
  const s=setup('not json',true);s.logger.record('http_error',{reason:'auth',http_status:403,endpoint:'state',authorization:'secret'},true);
  const r=s.logger.report();assert.equal(r.persistence_available,false);assert(r.records.some(x=>x.reason==='auth'));assert(!JSON.stringify(r).includes('authorization'));s.logger.clear();
}
{
  const saved=JSON.stringify([{at:2000000000000,event:'sample',snapshot_age_s:7,secret:'secret',url:'auth-url',reason:'raw-message'}, {at:2000000000000,event:'unknown',email:'secret'},null]);
  const r=setup(saved).logger.report();assert(!JSON.stringify(r).includes('secret'));assert(!JSON.stringify(r).includes('auth-url'));assert(r.records.some(x=>x.snapshot_age_s===7));
}
console.log('Diagnostics tests passed: bounds, retention, whitelist, reload, failure, transitions, throttling, clock, clear.');
