const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
(async()=>{
  let now=2000000000000,state={warning:false,reason:'none',snapshot_age_s:2,secret:'private'},next=0,mode='fail',pendingResolve;
  const timeouts=new Map(),stored=new Map(),requests=[],listeners={};
  const context={crypto:require('node:crypto').webcrypto,AbortSignal,window:{addEventListener:(e,f)=>listeners[e]=f},document:{visibilityState:'visible',getElementById:()=>null,addEventListener:()=>{}},navigator:{onLine:true},performance:{now:()=>now-2000000000000},Date:class extends Date{static now(){return now;}},localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)},setTimeout:(fn,delay)=>{timeouts.set(++next,{fn,delay});return next;},clearTimeout:id=>timeouts.delete(id),setInterval:()=>1,clearInterval:()=>{},MutationObserver:class{observe(){}disconnect(){}},fetch:async(url,options)=>{
    const body=JSON.parse(options.body);requests.push({url,options,body});
    if(mode==='fail')throw Error('network');
    if(mode==='pending')await new Promise(resolve=>pendingResolve=resolve);
    return {ok:true,json:async()=>({ack:body.records.map(r=>r.entry_id)})};
  }};
  vm.createContext(context);vm.runInContext(fs.readFileSync('local_monitor/web/diagnostics.js','utf8'),context);
  const log=context.window.LocalMonitorDiagnostics.create(()=>state);
  const settle=()=>new Promise(setImmediate);
  const fire=async()=>{const [id,t]=[...timeouts][0];timeouts.delete(id);now+=t.delay;t.fn();await settle();};
  await fire();assert.equal(log.report().server_upload.status,'failed');assert(log.report().server_upload.pending>0);
  mode='ok';await fire();assert.equal(log.report().server_upload.status,'ok');assert.equal(log.report().server_upload.pending,0);
  assert(!JSON.stringify(requests.map(x=>x.body)).includes('private'));assert.equal(requests[0].url,'/api/diagnostics');
  const client=requests[0].body.client_id;assert.equal(stored.get('lm-diagnostics-client'),client);
  mode='pending';state={warning:true,reason:'stale',snapshot_age_s:22};log.record('warning',{},true);await fire();
  const before=requests.length;log.record('http_error',{reason:'network'},true);await fire();assert.equal(requests.length,before,'no concurrent upload');
  pendingResolve();await settle();mode='ok';await fire();assert.equal(log.report().server_upload.pending,0);
  now+=2000;listeners.pagehide();await settle();assert.equal(requests.at(-1).options.keepalive,true);
  log.stop();console.log('Upload queue tests passed: retry, ack, IDs, no overlap, privacy, keepalive.');
})().catch(e=>{console.error(e);process.exitCode=1;});
