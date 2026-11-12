const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const dir='.agent-logs/2026-11-10--thread-preview-mockup/artifacts';
const baseline=JSON.parse(fs.readFileSync(dir+'/before-geometry.txt','utf8').split('### Result\n')[1].split('\n###')[0]);
async function suite(page,baseline,url){
 const assert=(v,m)=>{if(!v)throw Error(m)},errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>window.EventSource=class{addEventListener(){}close(){}});
 await page.route('**/api/state',r=>r.fulfill({json:{instance:'preview',seq:0,server_time:Date.now()/1000,snapshot:{at:Date.now()/1000,sessions:[],errors:[]},events:[],usage:[],collector_error:false}}));
 await page.goto(url);await page.waitForFunction(()=>data?.instance==='preview');
 await page.evaluate(()=>{
  fallbackActive=false;clearTimeout(fallbackTimer);
  const now=Date.now()/1000;
  window.previewRows=[
   {provider:'codex',session_id:'run',cwd:'/work/local-monitor',title:'진행 작업',status:'running'},
   {provider:'claude',session_id:'bg',cwd:'/work/local-monitor',title:'백그라운드 작업',status:'background'},
   {provider:'codex',session_id:'wait',cwd:'/work/local-monitor',title:'목록 미리보기 구성',status:'waiting_input',preview:{text:'',questions:[{question:'미리보기를 어떤 구성으로 표시할까요?',options:[{label:'메시지와 선택지 (추천)',description:'목록에서 바로 확인해요.'},{label:'메시지만',description:'선택지는 상세에서 확인해요.'}]}]}},
   {provider:'claude',session_id:'done',cwd:'/work/local-monitor',title:'폴더 전환 애니메이션 수정',status:'completed',completed_at:now-240,preview:{text:'폴더 선택과 스크롤 유지 동작을 수정했고 관련 검증을 통과했어요.\n\n정합 상태 · 맞아떨어진다\n목적 · 검토\n선택지\n1. 변경 확인 — 수정한 내용을 살펴봐요.\n2. 여기서 마무리\n추천 · 변경 확인'}},
   {provider:'antigravity',session_id:'no-source',cwd:'/work/design-notes',title:'원문 없는 작업',status:'completed',completed_at:now-100},
   {provider:'codex',session_id:'unknown',cwd:'/work/design-notes',title:'상태 확인',status:'unknown',observed_at:now},
  ];window.previewUpdate=()=>{const at=Date.now()/1000;serverClock.observe(at);applyState({...data,server_time:at,snapshot:{at,errors:[],sessions:previewRows}})};previewUpdate();
 });
 assert(await page.locator('.folder-task').count()===4,'running and background omitted');
 assert(await page.locator('.folder-totals').count()===0,'global counts removed');
 assert((await page.locator('.folder-summary').first().textContent()).includes('진행 2'),'project counts retained');
 assert((await page.locator('.folder-task[data-status=waiting_input] .folder-task-message').textContent())==='확인 중','pending indicator');
 assert(await page.locator('.folder-task[data-status=waiting_input] .folder-task-choices').count()===0,'pending choices hidden');
 assert(!(await page.locator('.folder-task[data-status=waiting_input]').getAttribute('aria-label')).includes('미리보기를 어떤'),'pending original absent from accessible name');
 await page.locator('.folder-task[data-status=waiting_input]').click();assert(await page.locator('.session-preview-options li').count()===2,'pending detail retains original');await page.keyboard.press('Escape');
 await page.evaluate(()=>{for(const row of previewRows.filter(r=>['wait','done'].includes(r.session_id)))row.preview_summary={model:'gpt-6-luna',status:'failed'};previewUpdate()});
 assert((await page.locator('.folder-task[data-status=waiting_input]').textContent()).includes('메시지와 선택지'),'structured choices');
 assert((await page.locator('.folder-task[data-status=completed]').first().textContent()).includes('변경 확인'),'footer choices');
 assert((await page.locator('.folder-task[data-status=unknown] .folder-task-state').textContent())==='상태 미확인','unknown separate from awaiting input');
 assert(await page.locator('.folder-task[data-status=unknown] .folder-task-message,.folder-task[data-status=unknown] .folder-task-choices').count()===0,'unknown preview absent');
 await page.evaluate(()=>{previewRows.find(r=>r.session_id==='unknown').preview={text:'숨길 이전 본문',questions:[{question:'숨길 질문',options:[{label:'숨길 선택지'}]}]};previewUpdate()});
 assert(!(await page.locator('.folder-task[data-status=unknown]').textContent()).includes('숨길'),'unknown existing content omitted');
 assert(!(await page.locator('.folder-task[data-status=unknown]').getAttribute('aria-label')).includes('숨길'),'unknown preview omitted from accessible name');
 await page.locator('.folder-task[data-status=waiting_input]').click();
 assert(await page.locator('#session-preview-detail').isVisible(),'message detail');assert(await page.locator('.session-preview-options li').count()===2,'full options');
 await page.keyboard.press('Escape');
 await page.locator('.folder-task[data-status=completed]').first().click();assert((await page.locator('.session-preview-body').textContent()).includes('추천 · 변경 확인'),'full body preserved');await page.keyboard.press('Escape');
 await page.evaluate(()=>{for(const row of previewRows.filter(r=>['wait','done'].includes(r.session_id)))row.preview_summary={model:'gpt-6-luna',lines:row.session_id==='wait'?['목적 · 미리보기 구성 개선','🔀 결정하기 · 메시지+선택지 / 메시지만']:['목적 · 폴더 전환·스크롤 개선','🔎 확인하기 · 변경 내용 검토']};previewUpdate()});
 assert(await page.locator('.is-ai-summary').count()===2,'two summaries rendered');
 assert(await page.locator('.folder-task[data-status=waiting_input] .folder-task-choices').count()===0,'no duplicate choices');
 await page.locator('.folder-task[data-status=completed]').first().click();assert((await page.locator('.session-preview-body').textContent()).includes('추천 · 변경 확인'),'summary detail retains original');await page.keyboard.press('Escape');
 await page.evaluate(()=>{for(const [i,label] of ['▶️ 이어가기','⏳ 기다리기','🧹 정리하기','✅ 마무리','⛔ 막힘','❔ 확인 필요'].entries())previewRows.push({provider:'codex',session_id:'action'+i,cwd:'/work/local-monitor',title:'행동 분류 예시 '+i,status:'waiting_input',preview:{text:'분류 예시 원문'},preview_summary:{model:'gpt-6-luna',lines:['목적 · 작업 목표 확인',label+' · 구체적인 다음 단계']}});previewUpdate()});
 const sizes=[];
 for(const before of baseline){
  await page.setViewportSize({width:before.width,height:900});await page.evaluate(t=>document.documentElement.dataset.theme=t,before.theme);
  const after=await page.evaluate(()=>Object.fromEntries(['.workshop-panel','.folder-board','.workshop-sidebar'].map(s=>[s,document.querySelector(s).getBoundingClientRect().toJSON()])));
  assert(JSON.stringify(after)===JSON.stringify(before.geometry),'same before/after geometry '+before.width+'/'+before.theme);
  assert(await page.locator('.folder-totals').count()===0,'global counts absent '+before.width);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.folder-list').scrollWidth<=document.querySelector('.folder-list').clientWidth),'no overflow');
  assert(await page.locator('.folder-task-state').evaluateAll(es=>es.every(e=>getComputedStyle(e).whiteSpace==='nowrap')),'one-line statuses');
  assert(await page.locator('.is-ai-summary').evaluateAll(es=>es.every(e=>e.children.length===2&&e.getBoundingClientRect().height===36)),'exactly two physical summary lines');
  sizes.push({width:before.width,theme:before.theme,unchanged:true});
  await page.screenshot({path:'.agent-logs/2026-11-10--thread-preview-mockup/artifacts/preview-'+before.theme+'-'+before.width+'.png'});
 }
 await page.evaluate(()=>{previewRows.push({provider:'codex',session_id:'child-running',cwd:'/work/local-monitor/build',title:'하위 진행',status:'running'});previewUpdate()});
 assert(await page.locator('.folder-chip').count()===0,'active-only subfolder hidden');
 assert((await page.locator('.folder-summary').first().textContent()).includes('진행 3'),'hidden child still counted in project');
 await page.evaluate(()=>{previewRows.find(r=>r.session_id==='child-running').status='waiting_input';previewUpdate()});
 await page.locator('.folder-chip').click();assert(await page.locator('.folder-detail').count()===1,'attention child becomes visible');
 await page.evaluate(()=>{previewRows.find(r=>r.session_id==='child-running').status='running';previewUpdate()});
 assert(await page.locator('.folder-chip').count()===0&&await page.locator('.folder-detail').count()===0,'resumed child chip and detail disappear');
 await page.evaluate(()=>{previewRows=previewRows.filter(r=>r.session_id!=='child-running');previewUpdate()});
 await page.evaluate(()=>{previewRows.push(...Array.from({length:30},(_,i)=>({provider:'codex',session_id:'long'+i,cwd:'/work/local-monitor',title:'긴 작업명 '.repeat(60),status:'waiting_input',preview:{text:'<img src=x onerror=alert(1)> '+ '긴 메시지 '.repeat(100),questions:[{question:'긴 질문 '.repeat(100),options:[{label:'긴 선택지 '.repeat(100)}]}]}})));previewUpdate()});
 await page.waitForTimeout(450);
 assert(await page.locator('.folder-list').evaluate(e=>e.scrollHeight>e.clientHeight),'internal scrolling');
 assert(await page.locator('.folder-task img').count()===0,'untrusted content rendered as text');
 await page.locator('.folder-task[data-status=waiting_input]').first().focus();await page.keyboard.press('Enter');assert(await page.locator('#workshop-dialog').evaluate(e=>e.open),'keyboard detail');await page.keyboard.press('Escape');
 await page.evaluate(()=>{previewRows=previewRows.map(r=>r.session_id==='done'?{...r,status:'running',preview:undefined}:r);previewUpdate()});
 assert(await page.locator('.folder-task').evaluateAll(es=>!es.some(e=>e.textContent.includes('폴더 전환 애니메이션 수정'))),'resumed result disappears');
 assert(!errors.length,errors.join('\n'));return {passed:true,sizes,checks:'count-only active, structured and text choices, full detail, keyboard, missing source, unknown distinction, long content, XSS text, resume, same baseline geometry, Luna two lines and original detail',errors};
}
const result=spawnSync('playwright-cli',['-s='+ (process.env.PREVIEW_BROWSER||'preview-qa'),'run-code','async page => ('+suite.toString()+')(page,'+JSON.stringify(baseline)+','+JSON.stringify(process.env.PREVIEW_URL||'http://127.0.0.1:3010/')+')'],{encoding:'utf8',maxBuffer:1024*1024});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status||(/### Error/.test(result.stdout)?1:0));
