'use strict';
(() => {
  const key='lm-connection-diagnostics-v1',limit=600,retention=86400000;
  const events=new Set(['start','sample','warning','recovery','sse_open','sse_error','sse_reset','sse_parse_error','sse_watchdog','http_ok','http_error','online','offline','visibility','pagehide']);
  const reasons=new Set(['none','collector','stale','sessions','auth','disconnected','unknown','timeout','network','invalid_json','unavailable']);
  const numeric=['snapshot_at','snapshot_age_s','raw_snapshot_age_s','message_age_s','failure_count','session_error_count','duration_ms','clock_delta_ms','server_clock_offset_ms'];
  const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  function clean(value){
    if(!value||!events.has(value.event)||!Number.isFinite(value.at))return null;
    const row={at:value.at,event:value.event};
    if(uuid(value.entry_id))row.entry_id=value.entry_id;
    for(const field of numeric)if(Number.isFinite(value[field]))row[field]=Math.round(value[field]*1000)/1000;
    for(const field of ['collector_error','fallback','warning','online'])if(typeof value[field]==='boolean')row[field]=value[field];
    if(reasons.has(value.reason))row.reason=value.reason;
    if(['visible','hidden','prerender'].includes(value.visibility))row.visibility=value.visibility;
    if(['none','connecting','open','closed'].includes(value.stream))row.stream=value.stream;
    if(['state','usage'].includes(value.endpoint))row.endpoint=value.endpoint;
    if(['server','http_date','unknown'].includes(value.clock_source))row.clock_source=value.clock_source;
    if(Number.isInteger(value.http_status)&&value.http_status>=0&&value.http_status<=599)row.http_status=value.http_status;
    return row;
  }
  window.LocalMonitorDiagnostics={create(read){
    let records=[],persistent=true,lastWarning='',previousWall=Date.now(),previousMono=performance.now();
    let client=crypto.randomUUID(),sendTimer=null,sendAt=Infinity,sending=false,nextAttempt=0;
    const sent=new Set(),uploadState={status:'waiting',last_attempt_at:null,last_success_at:null};
    try{const saved=localStorage.getItem('lm-diagnostics-client');if(uuid(saved))client=saved;else localStorage.setItem('lm-diagnostics-client',client);}catch{}
    const recent=new Map();
    const prune=()=>{records=records.filter(r=>r.at>=Date.now()-retention&&r.at<=Date.now()+retention).slice(-limit);};
    try{const saved=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(saved))records=saved.slice(-limit).map(clean).filter(Boolean).map(r=>({...r,entry_id:r.entry_id||crypto.randomUUID()}));prune();}catch{persistent=false;}
    const flush=()=>{prune();try{localStorage.setItem(key,JSON.stringify(records));persistent=true;}catch{persistent=false;}};
    function schedule(delay){
      const at=Math.max(Date.now()+delay,nextAttempt);
      if(sendTimer!==null&&sendAt<=at)return;
      clearTimeout(sendTimer);sendAt=at;sendTimer=setTimeout(()=>{sendTimer=null;sendAt=Infinity;upload();},Math.max(0,at-Date.now()));
    }
    async function upload(keepalive=false){
      if(sending||Date.now()<nextAttempt)return;
      prune();const batch=records.filter(r=>!sent.has(r.entry_id)).slice(-50);
      if(!batch.length)return;
      sending=true;uploadState.status='sending';uploadState.last_attempt_at=Date.now();nextAttempt=Date.now()+2000;
      try{
        const response=await fetch('/api/diagnostics',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,client_id:client,records:batch}),signal:AbortSignal.timeout(5000),keepalive});
        if(!response.ok)throw Error('upload failed');
        const result=await response.json(),ids=new Set(batch.map(r=>r.entry_id));
        if(!Array.isArray(result.ack)||!result.ack.some(id=>ids.has(id)))throw Error('invalid ack');
        for(const id of result.ack)if(ids.has(id))sent.add(id);
        while(sent.size>1200)sent.delete(sent.values().next().value);
        uploadState.status='ok';uploadState.last_success_at=Date.now();
      }catch{uploadState.status='failed';nextAttempt=Date.now()+30000;}
      finally{sending=false;if(records.some(r=>!sent.has(r.entry_id)))schedule(30000);}
    }
    function record(event,extra={},immediate=false){
      try{
        const now=Date.now(),mono=performance.now(),state=read()||{};
        const row=clean({...state,...extra,entry_id:crypto.randomUUID(),at:now,event,online:navigator.onLine,visibility:document.visibilityState,clock_delta_ms:(now-previousWall)-(mono-previousMono)});
        if(!row)return;
        const signature=JSON.stringify([event,row.reason,row.http_status,row.stream,row.fallback]);
        if(!['warning','recovery','sample'].includes(event)&&now-(recent.get(signature)??-Infinity)<5000)return;
        previousWall=now;previousMono=mono;
        recent.set(signature,now);records.push(row);prune();
        if(recent.size>64)recent.delete(recent.keys().next().value);
        if(immediate||event==='sample')flush();
        schedule(['warning','sse_error','sse_parse_error','sse_watchdog','http_error'].includes(event)?2000:30000);
      }catch{ /* Diagnostics must never interrupt rendering or transport. */ }
    }
    function warning(){
      try{const state=read()||{},signature=JSON.stringify([!!state.warning,state.reason]);
        if(signature===lastWarning)return;lastWarning=signature;
        record(state.warning?'warning':'recovery',{},true);
      }catch{}
    }
    const timer=setInterval(()=>{warning();record('sample');},10000);
    const observer=new MutationObserver(warning);
    for(const id of ['warning','connection']){const node=document.getElementById(id);if(node)observer.observe(node,{attributes:true,childList:true,characterData:true,subtree:true});}
    for(const event of ['online','offline','pagehide'])window.addEventListener(event,()=>{record(event,{},true);if(event==='pagehide')upload(true);});
    document.addEventListener('visibilitychange',()=>record('visibility',{},true));
    record('start',{},true);warning();
    const report=()=>{flush();return {version:1,exported_at:Date.now(),persistence_available:persistent,server_upload:{...uploadState,client_id:client,pending:records.filter(r=>!sent.has(r.entry_id)).length},records:records.map(r=>({...r}))};};
    return {record,report,clear(){records=[];recent.clear();lastWarning='';try{localStorage.removeItem(key);persistent=true;}catch{persistent=false;}},download(){
      const blob=new Blob([JSON.stringify(report(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download='local-monitor-diagnostics-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    },stop(){clearInterval(timer);clearTimeout(sendTimer);observer.disconnect();}};
  }};
})();
