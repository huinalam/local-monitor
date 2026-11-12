const {test}=require('node:test'),assert=require('node:assert/strict');
const {groups,hierarchy,layout}=require('../local_monitor/web/folder-board.js');
const row=(id,cwd,status='running',provider='codex')=>({session_id:id,cwd,status,provider,title:'작업 '+id,completed_at:950});
const snapshot=sessions=>({at:1000,sessions});
test('full paths separate same folder name, providers share folder, identities deduplicate',()=>{
 const r=row('a','/a/project');const g=groups(snapshot([r,r,row('a','/a/project','running','claude'),row('b','/b/project')]),1000);
 assert.equal(g.length,2);assert.equal(g[0].rows.length,2);assert.equal(g[0].active,2);
});
test('current completion excludes resumed, expired and future tasks; attention stays',()=>{
 const r=row('a','/a','completed');let s=snapshot([r,row('a','/a'),row('b','/a','waiting_input'),{...row('c','/a','completed'),completed_at:-800},{...row('d','/a','completed'),completed_at:1001},row('e','/a','disconnected')]);
 const g=groups(s,1000);assert.equal(g[0].done,0);assert.equal(g[0].rows.length,2);
 assert.equal(groups(snapshot([r]),2749.99)[0].done,1);assert.equal(groups(snapshot([r]),2750).length,0);
});
test('filters, full path search, missing folders, historical unknown',()=>{
 const s=snapshot([row('one','/a','background'),row('two','/a','completed','claude'),row('three','','failed'),{...row('old','/old','unknown'),reason:'no_recent_evidence',observed_at:1,process_verified:false}]);
 assert.equal(groups(s,1000).length,2);assert.equal(groups(s,1000,{provider:'claude'})[0].rows.length,1);
 assert.equal(groups(s,1000,{query:'CLAUDE'})[0].done,1);assert.equal(groups(s,1000,{query:'/a',mode:'running'})[0].active,1);
 assert.equal(groups(s,1000,{mode:'completed'})[0].done,1);assert.equal(groups(s,1000,{query:'absent'}).length,0);
 assert.ok(groups(s,1000).some(g=>g.name==='폴더 미확인'));
});
test('hierarchy attaches to nearest observed ancestor, compresses gaps and aggregates once',()=>{
 const paths=['/work/app','/work/app/src','/work/app/src/ui/components','/work/application','/else/app'];
 const g=hierarchy(groups(snapshot(paths.map((path,i)=>row(String(i),path,i===0?'completed':i===2?'waiting_input':'running'))),1000));
 const byPath=new Map(g.map(group=>[group.path,group]));
 assert.equal(byPath.get(paths[1]).parentPath,paths[0]);
 assert.equal(byPath.get(paths[2]).parentPath,paths[1]);assert.equal(byPath.get(paths[2]).label,'ui/components');
 assert.equal(byPath.get(paths[2]).depth,2);assert.equal(byPath.get(paths[3]).parentPath,null);
 assert.deepEqual(byPath.get(paths[0]).total,{active:1,done:1,attention:1});
 const parentIndex=g.findIndex(group=>group.path===paths[0]);
 assert.deepEqual(g.slice(parentIndex,parentIndex+3).map(group=>group.path),paths.slice(0,3));
 assert.equal(g.reduce((n,group)=>n+group.rows.length,0),5);
});
test('collapse hides descendants, retains child collapse, and filters promote surviving folders',()=>{
 const s=snapshot([row('root','/app','completed','claude'),row('child','/app/src'),row('deep','/app/src/ui')]);
 const closed=new Set(['/app','/app/src']);
 assert.deepEqual(hierarchy(groups(s,1000),closed).map(g=>g.path),['/app']);
 closed.delete('/app');assert.deepEqual(hierarchy(groups(s,1000),closed).map(g=>g.path),['/app','/app/src']);
 const filtered=hierarchy(groups(s,1000,{provider:'codex'}));
 assert.equal(filtered[0].path,'/app/src');assert.equal(filtered[0].parentPath,null);assert.equal(filtered[1].depth,1);
 assert.equal(hierarchy(groups(s,2750))[0].path,'/app/src');
});
test('path boundaries, trailing and Windows separators, missing paths and roots stay distinct',()=>{
 const paths=['/app/','/app/src','/application','C:\\app','C:\\app\\src\\ui','D:\\app\\src','','relative','/relative/child','//server/share','//server/share/src','/server/share/other'];
 const g=hierarchy(groups(snapshot(paths.map((path,i)=>row(String(i),path))),1000)),byPath=new Map(g.map(group=>[group.path,group]));
 assert.equal(byPath.get('/app/src').parentPath,'/app/');assert.equal(byPath.get('/application').depth,0);
 assert.equal(byPath.get('C:\\app\\src\\ui').label,'src/ui');assert.equal(byPath.get('D:\\app\\src').depth,0);
 assert.equal(byPath.get('').parentPath,null);assert.equal(byPath.get('/relative/child').parentPath,null);
 assert.equal(byPath.get('//server/share/src').parentPath,'//server/share');assert.equal(byPath.get('/server/share/other').parentPath,null);
});
test('subtree activity sorts roots and siblings without interleaving descendants',()=>{
 const s=snapshot([row('a','/alpha','completed'),row('b','/beta','completed'),row('b1','/beta/a-idle','completed'),row('b2','/beta/z-active'),row('deep','/beta/z-active/leaf','completed')]);
 assert.deepEqual(hierarchy(groups(s,1000)).map(g=>g.path),['/beta','/beta/z-active','/beta/z-active/leaf','/beta/a-idle','/alpha']);
 assert.equal(groups(s,1000).find(g=>g.path==='/beta').active,0,'aggregation does not mutate direct groups');
});
test('chip layout opens only selected siblings, retaining nested choices through parent collapse',()=>{
 const g=groups(snapshot(['/app','/app/src','/app/tests','/app/src/ui','/app/src/lib'].map((path,i)=>row(String(i),path,'waiting_input'))),1000);
 const selected=new Map();
 assert.deepEqual(layout(g).map(x=>[x.kind,x.path]),[['folder','/app'],['chips','/app']]);
 selected.set('/app','/app/src');selected.set('/app/src','/app/src/ui');
 assert.deepEqual(layout(g,new Set(),selected).filter(x=>x.kind==='folder').map(x=>x.path),['/app','/app/src','/app/src/ui']);
 selected.set('/app','/app/tests');
 assert.deepEqual(layout(g,new Set(),selected).filter(x=>x.kind==='folder').map(x=>x.path),['/app','/app/tests']);
 assert.equal(layout(g,new Set(['/app']),selected).length,1);
 selected.set('/app','/app/src');assert.equal(layout(g,new Set(),selected).at(-1).path,'/app/src/ui');
 selected.delete('/app');assert.equal(layout(g,new Set(),selected).length,2);
});
test('chip selections apply only to current children, filtered roots stay visible and counts do not duplicate',()=>{
 const g=groups(snapshot(['/app','/app/src','/app/tests'].map((path,i)=>row(String(i),path,'waiting_input'))),1000);
 const selected=new Map([['/app','/app/src']]);
 assert.deepEqual(layout(g.filter(x=>x.path!=='/app'),new Set(),selected).map(x=>x.path),['/app/src','/app/tests']);
 const remaining=layout(g.filter(x=>x.path!=='/app/src'),new Set(),selected);
 assert.equal(remaining[1].selected,null);assert.equal(remaining[1].children[0].path,'/app/tests');
 const opened=layout(g,new Set(),selected);
 assert.equal(opened.filter(x=>x.kind==='folder').reduce((n,x)=>n+x.rows.length,0),2);
 assert.equal(opened[1].children.reduce((n,x)=>n+x.total.attention,0),2);
});

test('active-only subfolders are hidden after aggregation; visible descendants retain their ancestors',()=>{
 const s=snapshot([row('root','/app'),row('run','/app/run'),row('bg','/app/bg','background'),row('mid','/app/mid'),row('done','/app/mid/deep','completed'),row('wait','/app/wait','waiting_input')]);
 const selected=new Map([['/app','/app/run']]);
 const view=layout(groups(s,1000),new Set(),selected);
 assert.equal(view[0].total.active,4);assert.equal(view[0].total.done,1);assert.equal(view[0].total.attention,1);
 assert.deepEqual(view[1].children.map(g=>g.path),['/app/mid','/app/wait']);
 assert.equal(view[1].selected,null);assert.equal(view.length,2);
 const onlyActive=layout(groups(snapshot([row('root','/app'),row('run','/app/run')]),1000));
 assert.equal(onlyActive.length,1);assert.equal(onlyActive[0].total.active,2);assert.equal(onlyActive[0].hasChildren,false);
 const resumed=layout(groups(snapshot([row('root','/app'),row('run','/app/run','waiting_input')]),1000),new Set(),selected);
 assert.equal(resumed.at(-1).path,'/app/run');
});
