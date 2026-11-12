import {readFile,writeFile,rename,mkdir,symlink,open,unlink,chmod} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Codex} from '@openai/codex-sdk';
import {MODEL,readCache,selectRow,recordAttempt,recordResult,recordFailure,prompt,schema,formatSummary} from './core.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const runtime=resolve(process.argv[2]||join(here,'../../.runtime'));
const privateRoot=join(runtime,'preview-summary'),cachePath=join(runtime,'preview-summaries.json');
await mkdir(privateRoot,{recursive:true,mode:0o700});await chmod(privateRoot,0o700);
const lockPath=join(privateRoot,'worker.lock');
async function lock(){
  try{const f=await open(lockPath,'wx',0o600);await f.writeFile(String(process.pid));await f.close();}
  catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(await readFile(lockPath,'utf8'));try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){await unlink(lockPath);return lock();}throw e;}throw new Error('worker_already_running');}
}
await lock();
let stopping=false,active;
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{stopping=true;active?.abort();});
async function json(path){let f;try{f=await open(path,'r');const buffer=Buffer.alloc(4*1024*1024+1);const {bytesRead}=await f.read(buffer,0,buffer.length,0);if(bytesRead===buffer.length)return null;return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));}catch{return null;}finally{await f?.close();}}
async function save(cache){const tmp=cachePath+'.tmp';await writeFile(tmp,JSON.stringify(cache),{mode:0o600});await chmod(tmp,0o600);await rename(tmp,cachePath);}
try{
  const isolated=join(privateRoot,'codex-home'),cwd=join(privateRoot,'empty');
  await mkdir(isolated,{recursive:true,mode:0o700});await mkdir(cwd,{recursive:true,mode:0o700});
  // Reuse the local login without copying credentials into code or logs.
  const loginHome=process.env.CODEX_HOME||join(homedir(),'.codex');
  try{await symlink(join(loginHome,'auth.json'),join(isolated,'auth.json'));}catch(e){if(e.code!=='EEXIST')throw e;}
  const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LOCAL_MONITOR_CODEX_BIN'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));env.CODEX_HOME=isolated;
  const codex=new Codex({codexPathOverride:join(here,'codex-ephemeral.sh'),env,config:{project_doc_max_bytes:0,web_search:'disabled',history:{persistence:'none'},features:{shell_tool:false,view_image:false,remote_plugin:false},analytics:{enabled:false}}});
  while(!stopping){
    const now=Date.now()/1000,stored=await json(cachePath),cache=readCache(stored,now),snapshot=await json(join(runtime,'snapshot.json'));
    if(JSON.stringify(stored)!==JSON.stringify(cache))await save(cache);
    // Do not send stale on-disk state after the monitor has stopped.
    const row=snapshot&&now-snapshot.at<90?selectRow(snapshot.sessions||[],cache,now):null;
    if(row){
      recordAttempt(cache,row,now);await save(cache);
      active=new AbortController();const timer=setTimeout(()=>active.abort(),60000);
      try{
        const thread=codex.startThread({model:MODEL,threadSource:'local-monitor-summary',workingDirectory:cwd,skipGitRepoCheck:true,sandboxMode:'read-only',approvalPolicy:'never',modelReasoningEffort:'low',webSearchMode:'disabled'});
        const result=await thread.run(prompt(row),{outputSchema:schema,signal:active.signal});
        recordResult(cache,row,formatSummary(JSON.parse(result.finalResponse)),Date.now()/1000);await save(cache);
        console.log(JSON.stringify({event:'summary_ready',model:MODEL,at:Date.now()/1000}));
      }catch{recordFailure(cache,row,Date.now()/1000);await save(cache);console.error(JSON.stringify({event:'summary_failed',at:Date.now()/1000}));}
      finally{clearTimeout(timer);active=null;}
    }
    if(process.argv.includes('--once'))break;
    if(!stopping)await delay(5000);
  }
}finally{await unlink(lockPath).catch(()=>{});}
