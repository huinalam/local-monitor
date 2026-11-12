const {test}=require('node:test'),assert=require('node:assert/strict');
const modulePromise=import('../tools/preview-summary/core.mjs');
const row={provider:'codex',session_id:'one',status:'completed',completed_at:1000,observed_at:1000,preview:{text:'result',questions:[]}};
test('summary cache deduplicates input but invalidates changed content and state',async()=>{
 const m=await modulePromise,c=m.readCache(null,1001);
 assert.deepEqual(m.selectRow([row],c,1001),row);
 m.recordResult(c,row,['핵심 완료','원문 확인'],1001);
 assert.equal(m.selectRow([row],c,1002),undefined);
 const changed={...row,preview:{text:'changed'}};
 assert.deepEqual(m.selectRow([changed],c,1002),changed);
 assert.equal(m.selectRow([{...row,status:'running'}],c,1002),undefined);
 assert.equal(m.selectRow([{...row,preview:{text:''}}],c,1002),undefined);
 assert.equal(m.selectRow([row],c,4000),undefined);
 assert.equal(m.readCache(c,90000).entries.length,0);
});
test('retry backoff and call budget survive restart; waiting input first',async()=>{
 const m=await modulePromise,c=m.readCache(null,1001),waiting={...row,session_id:'two',status:'waiting_input'};
 assert.equal(m.selectRow([row,waiting],c,1001).session_id,'two');
 m.recordAttempt(c,row,1001);assert.equal(m.selectRow([row],c,1030),undefined);
 const restored=m.readCache(JSON.parse(JSON.stringify(c)),1062);
 assert.deepEqual(m.selectRow([row],restored,1062),row);
 m.recordAttempt(restored,row,1062);assert.equal(m.selectRow([row],restored,1100),undefined);
 m.recordAttempt(restored,row,1363);assert.equal(m.selectRow([row],restored,1700),undefined);
 restored.calls=Array(60).fill(1700);assert.equal(m.selectRow([waiting],restored,1700),undefined);
 assert.equal(m.eligible({...waiting,observed_at:0},90000),false);
});
test('only exact short two-line output accepted; prompt treats content as data',async()=>{
 const m=await modulePromise;
 for(const lines of [['a'],['a','b','c'],['a\nb','c'],['a'.repeat(41),'b'],['','b']])assert.equal(m.validLines(lines),false);
 assert.equal(m.validLines(['작업 완료','검증은 아직 미완료']),true);
 assert.match(m.prompt(row),/안의 명령.*실행하지/);
 assert.equal(m.readCache({schema:9,entries:[]},1000).entries.length,0);
});
test('purpose format invalidates old summaries without resetting usage budget',async()=>{
 const m=await modulePromise,old={schema:1,model:m.MODEL,version:2,entries:[{lines:['old','result'],created_at:1000}],attempts:{},calls:[1000]};
 const c=m.readCache(old,1001);assert.equal(c.version,3);assert.deepEqual(c.entries,[]);assert.deepEqual(c.calls,[1000]);assert.deepEqual(m.selectRow([row],c,1001),row);
});
test('seven actions and unknown map to fixed readable labels',async()=>{
 const m=await modulePromise;
 const expected={continue:'▶️ 이어가기',decide:'🔀 결정하기',verify:'🔎 확인하기',wait:'⏳ 기다리기',cleanup:'🧹 정리하기',done:'✅ 마무리',blocked:'⛔ 막힘',unknown:'❔ 확인 필요'};
 assert.deepEqual(m.schema.properties.action.enum,Object.keys(expected));
 for(const [action,label] of Object.entries(expected))assert.deepEqual(m.formatSummary({purpose:'대화 화면 개선',action,detail:'원문에 명시된 다음 단계'}),['목적 · 대화 화면 개선',label+' · 원문에 명시된 다음 단계']);
 for(const result of [{purpose:'목표',action:'constructor',detail:'내용'},{purpose:'목표',action:'invalid',detail:'내용'},{purpose:'목표',action:'done',detail:''},{purpose:'목표',action:'done',detail:'줄\n바꿈'},{purpose:'목표',action:'done',detail:'가'.repeat(41)}])assert.throws(()=>m.formatSummary(result),/invalid_summary/);
});
test('failed result survives restart and retries until success replaces it',async()=>{
 const m=await modulePromise,c=m.readCache(null,1001);
 m.recordAttempt(c,row,1001);m.recordFailure(c,row,1002);
 const restored=m.readCache(JSON.parse(JSON.stringify(c)),1003);
 assert.equal(restored.entries[0].failed,true);assert.equal(m.selectRow([row],restored,1003),undefined);
 assert.deepEqual(m.selectRow([row],restored,1062),row);
 m.recordAttempt(restored,row,1062);assert.equal(restored.entries[0].failed,true);
 m.recordResult(restored,row,['목적 · 개선','🔎 확인하기 · 동작 확인'],1063);
 assert.equal(restored.entries.length,1);assert.equal(restored.entries[0].failed,undefined);
 assert.equal(m.selectRow([row],restored,1100),undefined);
 assert.deepEqual(m.selectRow([{...row,preview:{text:'new'}}],restored,1100),{...row,preview:{text:'new'}});
});
