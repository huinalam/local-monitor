const {test}=require('node:test'),assert=require('node:assert/strict');
const {readPreview:read}=require('../local_monitor/web/folder-board.js');
test('footer choices are extracted without exposing footer as summary',()=>{
 const r=read({preview:{text:'작업 완료.\n\n정합 상태 · 맞아떨어진다\n목적 · 확인\n선택지\n1. 변경 확인 — 검토\n2. 마무리\n추천 · 1번'}});
 assert.equal(r.summary,'작업 완료.');assert.deepEqual(r.choices,['변경 확인 — 검토','마무리']);
 assert.deepEqual(read({preview:{text:'결과\n1. 수정\n2. 검증'}}).choices,[]);
});
test('structured questions and old-server fallback',()=>{
 const r=read({preview:{text:'context',questions:[{question:'어느 쪽?',options:[{label:'A',description:'추천'}]}]}});
 assert.equal(r.summary,'어느 쪽?');assert.deepEqual(r.choices,['A']);assert.equal(r.questions[0].options[0].description,'추천');
 assert.equal(read({}).available,false);assert.match(read({status:'unknown'}).summary,/상태/);
 assert.equal(read({preview:{text:'<img src=x onerror=alert(1)>'}}).text,'<img src=x onerror=alert(1)>');
});
test('Luna lines replace list prose while original and choices remain available',()=>{
 const row={status:'completed',preview:{text:'원문 전체\n선택지\n1. 원문 검토'},preview_summary:{model:'gpt-6-luna',lines:['완료 사항 요약','원문 검토']}};
 const r=read(row);assert.equal(r.summary,'완료 사항 요약\n원문 검토');assert.equal(r.text,row.preview.text);assert.deepEqual(r.choices,['원문 검토']);
 assert.equal(read({...row,status:'running'}).aiLines,null);
 assert.equal(read({...row,preview_summary:{model:'gpt-6-luna',lines:['a\nb','c']}}).aiLines,null);
});
test('summary pending hides prose, failure restores it, success takes precedence',()=>{
 const row={status:'completed',preview:{text:'원문 본문\n선택지\n1. 검토'}};
 assert.equal(read(row).summary,'확인 중');assert.equal(read(row).pending,true);assert.equal(read(row).rawSummary,'원문 본문');
 const failure={...row,preview_summary:{model:'gpt-6-luna',status:'failed'}};
 assert.equal(read(failure).summary,'원문 본문');assert.equal(read(failure).pending,false);
 assert.equal(read({...failure,preview_summary:{model:'gpt-6-luna',lines:['목적 · 개선','▶️ 이어가기 · 검토']}}).summary,'목적 · 개선\n▶️ 이어가기 · 검토');
 assert.equal(read({...row,status:'waiting_input'}).pending,true);
 assert.equal(read({status:'completed'}).pending,false);
});
