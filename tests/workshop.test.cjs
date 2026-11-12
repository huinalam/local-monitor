const {test}=require('node:test');const assert=require('node:assert/strict');
const {model,completed}=require('../local_monitor/web/workshop.js');
const row=(provider,session_id,status)=>({provider,session_id,status});
test('mixed provider sessions, unique identity, background included once',()=>{
 const state={snapshot:{at:1000,sessions:[row('codex','1','running'),row('codex','1','running'),row('codex','2','background'),row('codex','3','waiting_input'),row('claude','1','waiting_input'),row('antigravity','1','idle')]},completion_window:{schema:1,seconds:1800,partial:true,entries:[]}};
 const r=model(state,1000);assert.equal(r.rooms[0].active,2);assert.equal(r.rooms[0].pose,'working');assert.equal(r.rooms[0].jobs[0].status,'waiting_input');assert.equal(r.rooms[1].pose,'waiting');assert.equal(r.rooms[2].pose,'sleeping');assert.equal(r.partial,false);
});
test('current completed tasks are unique and disappear on resume, recompletion starts a new window',()=>{
 const task={provider:'codex',session_id:'a',status:'completed',completed_at:990,observed_at:995};
 const state={snapshot:{at:1000,sessions:[task,{...task}]},completion_window:{schema:1,seconds:1800,entries:[1,2,3].map(i=>({provider:'codex',session_id:'a',turn_id:String(i),at:985+i}))}};
 assert.equal(model(state,1000).rooms[0].done,1);
 for(const status of ['running','background','waiting_input','failed','unknown','idle','disconnected','interrupted']){
  state.snapshot.sessions=[{...task,status}];assert.equal(model(state,1000).rooms[0].done,0,status);
 }
 state.snapshot.sessions=[{...task,completed_at:1000}];
 assert.equal(model(state,2200).rooms[0].done,1,'20 minutes still visible');
 assert.equal(model(state,2799.99).rooms[0].done,1);assert.equal(model(state,2800).rooms[0].done,0);
 state.snapshot.sessions=[];assert.equal(model(state,1000).rooms[0].done,0);
});
test('snapshot task identity, timestamps and legacy sources stay explicit',()=>{
 const task={provider:'codex',session_id:'a',status:'completed',completed_at:999};
 const state={snapshot:{at:1000,sessions:[task,{...task,provider:'claude'}]}};
 assert.equal(model(state,1000).entries.length,2,'different providers remain distinct without event window');
 for(const value of [null,undefined,NaN,Infinity,1001]){
  state.snapshot.sessions=[{...task,completed_at:value}];assert.equal(model(state,1000).entries.length,0);assert.equal(model(state,1000).partial,true);
 }
 state.snapshot.sessions=[{...task,completed_at:-800}];assert.equal(model(state,1000).entries.length,0);assert.equal(model(state,1000).partial,false);
 state.snapshot.sessions=[task,{...task,status:'running'}];assert.equal(model(state,1000).entries.length,0,'same normalized current row as active count');
 assert.equal(completed(null,1000),null);assert.equal(completed(state.snapshot,null),null);
});
test('unknown and failure never sleep, absent data is not zero',()=>{
 assert.equal(model(null,null).ready,false);assert.equal(model(null,null).rooms[0].done,null);
 for(const [status,pose] of [['unknown','unknown'],['failed','failed'],['waiting_input','waiting'],['background','background']])assert.equal(model({snapshot:{at:1,sessions:[row('codex','a',status)]}},2).rooms[0].pose,pose);
});
const {quota}=require('../local_monitor/web/workshop.js');
test('daily HP uses daily allocation, caps extremes, handles zero and partial',()=>{
 const make=(recommended,used)=>({status:'ok',observed_at:100000,windows:[{label:'주간',daily:{status:'ok',recommended,used,partial:true}}]});
 assert.equal(quota(make(20,5),100000).percent,75);
 assert.equal(quota(make(20,25),100000).overagePercent,25);
 assert.equal(quota(make(0,2),100000).overagePercent,null);
 assert.equal(quota(make(20,25),100000).percent,0);assert.equal(quota(make(20,25),100000).exceeded,true);
 assert.equal(quota(make(0,0),100000).percent,0);assert.equal(quota(make(0,0),100000).exceeded,false);
 assert.equal(quota(make(20,0),100000).percent,100);assert.equal(quota(make(20,0),100000).partial,true);
 for(const v of [null,NaN,-1,Infinity])assert.equal(quota(make(v,0),100000).percent,null);
 const row=make(20,5);assert.equal(quota(row,100601).percent,null);assert.equal(quota(row,100000,true).percent,null);
 row.windows[0].daily.status='account_unknown';assert.equal(quota(row,100000).percent,null);
 row.windows[0].daily.status='ok';row.observed_at=75600-1;assert.equal(quota(row,75600).percent,null,'KST 06:00 expires previous day');
});

test('old unverified evidence is historical, current activity and verified processes remain current',()=>{
 const old={provider:'claude',session_id:'old',status:'unknown',reason:'no_recent_evidence',observed_at:399};
 const room=sessions=>model({snapshot:{at:1000,sessions}},1000).rooms[1];
 assert.equal(room([old]).historical,1);assert.equal(room([old]).unknown,0);assert.equal(room([old]).pose,'sleeping');
 assert.equal(room([{...old,process_verified:true}]).unknown,1);
 assert.equal(room([{...old,observed_at:400}]).unknown,1);
 assert.equal(room([{...old,reason:'other'}]).unknown,1);
 assert.equal(room([old,{provider:'claude',session_id:'live',status:'running'}]).active,1);
});

const {vehicleState}=require('../local_monitor/web/workshop.js');
test('vehicles settle across thresholds while parked and uncertain states cancel pending changes',()=>{
 for(const [count,tier] of [[1,1],[2,2],[3,2],[4,3],[120,3]])assert.equal(vehicleState(null,count,true,100).tier,tier);
 let v=vehicleState(null,1,true,100);
 v=vehicleState(v,4,true,101);assert.equal(v.tier,1);
 v=vehicleState(v,4,true,103.99);assert.equal(v.tier,1);
 v=vehicleState(v,4,true,104);assert.equal(v.tier,3);
 v=vehicleState(v,2,true,105);assert.equal(v.pending,2);
 v=vehicleState(v,4,true,106);assert.equal(v.pending,null);
 v=vehicleState(v,1,true,107);
 v=vehicleState(v,0,false,108);assert.deepEqual(v,{tier:3,pending:null,since:null});
 v=vehicleState(v,1,true,200);assert.equal(v.tier,3);
 v=vehicleState(v,1,true,203);assert.equal(v.tier,1);
 v=vehicleState(v,2,true,204);v=vehicleState(v,2,true,190);assert.equal(v.since,190,'clock rollback restarts interval');
 assert.equal(vehicleState(null,0,false,100).tier,1);
 assert.equal(vehicleState(null,4,true,300).tier,3,'reset starts from current observation');
});
