'use strict';
const $ = id => document.getElementById(id);
const labels = {running:'작업 중', completed:'응답 완료', idle:'대기', waiting_input:'입력 대기', background:'백그라운드',failed:'오류',interrupted:'중단',unknown:'확인 불가',disconnected:'연결 종료'};
const activeStates = new Set(['running','background']);
const completionRetentionSeconds = 20 * 60;
function recentCompletion(row, now=Date.now()/1000) {
  const at=row.completed_at;
  return ['completed','disconnected'].includes(row.status)&&Number.isFinite(at)&&now>=at&&now-at<completionRetentionSeconds;
}
function sessionActivity(row){
  const observed=Number.isFinite(row.observed_at)?row.observed_at:0;
  return ['completed','disconnected'].includes(row.status)&&Number.isFinite(row.completed_at)?Math.max(observed,row.completed_at):observed;
}
const attentionStates = new Set(['waiting_input','failed']);
let data = null, filter = 'active', provider = 'all', query = '', instance = null, cursor = null;
let journalView='sessions',journalSession=null,journalOpener=null,workshopModel=null;
let usageDetailProvider=null, usageDetailRow=null, usageDetailRequest=0;
function element(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
function elapsed(at) { if (!at) return '기록 없음'; const seconds = Math.max(0, Date.now()/1000-at); if(seconds<60)return '방금'; if(seconds<3600)return Math.floor(seconds/60)+'분 전'; if(seconds<86400)return Math.floor(seconds/3600)+'시간 전';return Math.floor(seconds/86400)+'일 전'; }
function name(p) { return ({claude:'Claude Code',codex:'Codex',antigravity:'Antigravity'})[p]||p; }
$('refresh').addEventListener('click',()=>window.location.reload());
function syncFullscreen() {
  const active=!!document.fullscreenElement;
  const supported=!!document.fullscreenEnabled&&typeof document.documentElement.requestFullscreen==='function';
  $('fullscreen-enter').hidden=active;
  $('fullscreen-enter').disabled=!supported;
  $('fullscreen-enter').title=supported?'전체화면으로 보기 · Esc 키로 나가기':'이 브라우저에서는 전체화면을 지원하지 않아요. 브라우저 메뉴를 이용해 주세요.';
  $('fullscreen').disabled=!supported&&!active;
  $('fullscreen').textContent=active?'전체 화면 나가기':'전체 화면';
  $('fullscreen').setAttribute('aria-pressed',String(active));
  $('fullscreen-note').textContent=supported||active?'Esc 키로 전체 화면을 나갈 수 있어요.':'이 브라우저에서는 전체 화면 버튼을 지원하지 않아요. 브라우저 메뉴를 이용해 주세요.';
}
async function toggleFullscreen(){
  try {
    if(document.fullscreenElement)await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    syncFullscreen();
  } catch {
    syncFullscreen();
    $('fullscreen-note').textContent='전체 화면으로 전환하지 못했어요. 브라우저 메뉴를 이용해 주세요.';
    $('fullscreen-enter').title=$('fullscreen-note').textContent;
  }
}
$('fullscreen').addEventListener('click',toggleFullscreen);
$('fullscreen-enter').addEventListener('click',toggleFullscreen);
document.addEventListener('fullscreenchange',syncFullscreen);
syncFullscreen();
function permission() {
  const supported = 'Notification' in window;
  const value = supported ? Notification.permission : 'unsupported';
  $('notifications').textContent = {granted:'브라우저 알림 켜짐 ✓',denied:'브라우저 알림 차단됨',default:'브라우저 알림 켜기 ↗',unsupported:'페이지 알림 사용 중'}[value];
  $('permission-note').textContent = {granted:'이 브라우저에 새 완료 알림을 보냅니다. 페이지는 열어두세요.',denied:'브라우저에서 알림이 차단됐어요. 사이트 설정에서 허용할 수 있어요.',default:'브라우저 알림을 허용하면 다른 탭에서도 확인할 수 있어요.',unsupported:'이 브라우저는 시스템 알림을 지원하지 않아요. 페이지 알림은 계속 표시됩니다.'}[value];
}
$('notifications').addEventListener('click', async () => {
  if (!('Notification' in window)) { toast({title:'페이지 안에서 완료 알림을 확인할 수 있어요.', provider:'codex'},true); return; }
  if (Notification.permission==='default') { try { await Notification.requestPermission(); } catch {} }
  permission();
});
function toast(event, info=false) {
  const card=element('div','toast');card.dataset.eventId=event.id || 'info';
  card.append(element('span','tick','✓'));
  const body=element('div');body.append(element('strong','',info?'알림 안내':name(event.provider)+' · 응답 완료'),element('p','',event.title));
  const close=element('button','','×');close.setAttribute('aria-label','알림 닫기');close.onclick=()=>card.remove();
  card.append(body,close);$('toasts').append(card);
  while ($('toasts').children.length>3) $('toasts').firstChild.remove();
  setTimeout(()=>card.remove(),20000);
}
// Original pixel star, built locally so no image or font download is needed.
function weatherCharacter(){
  if(document.documentElement.dataset.theme!=='real')return 'star';
  const {weather,sky}=document.documentElement.dataset;
  if(weather==='clear')return sky==='night'?'moon':'sun';
  if(['partly','cloudy','fog','storm'].includes(weather))return 'cloud';
  if(weather==='rain')return 'drop';if(weather==='snow')return 'snow';return 'star';
}
function starBadge(state) {
  const character=weatherCharacter();
  const characterNames={star:'별',sun:'해',moon:'달',cloud:'구름',drop:'빗방울',snow:'눈송이'};
  const badge=element('span','star-status '+state);
  badge.dataset.character=character;
  const description=(state==='background'?'백그라운드 작업 중':labels[state])+' · '+characterNames[character];
  badge.setAttribute('role','img');badge.setAttribute('aria-label',description);badge.title=description;
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox','0 0 18 18');svg.setAttribute('aria-hidden','true');
  svg.setAttribute('shape-rendering','crispEdges');svg.classList.add('star-character');
  const pixels=['       XX       ','      XYYX      ','      XYYX      ','     XYYYYX     ',' XXXXXYYYYXXXXX ','XYYYYYYYYYYYYYYX',' XYYYYYYYYYYYYX ','  XYYYYYYYYYYX  ','   XYYYYYYYYX   ','   XYYYYYYYYX   ','  XYYYYYYYYYYX  ','  XYYYYXXYYYYX  ',' XYYYXX  XXYYYX ',' XXXX      XXXX '];
  const rect=(x,y,w,h,color)=>{const r=document.createElementNS(ns,'rect');for(const [key,value] of Object.entries({x,y,width:w,height:h,fill:color}))r.setAttribute(key,value);svg.append(r);};
  const path=(d,fill,stroke)=>{const p=document.createElementNS(ns,'path');p.setAttribute('d',d);p.setAttribute('fill',fill);if(stroke){p.setAttribute('stroke',stroke);p.setAttribute('stroke-width','1');p.setAttribute('stroke-linejoin','miter');}svg.append(p);};
  if(character==='star'){
    pixels.forEach((line,y)=>[...line].forEach((pixel,x)=>{if(pixel!==' ')rect(x+1,y+2,1,1,pixel==='X'?'#9a602e':'#ffe388');}));
    rect(7,4,2,1,'#fff6c5');
  }else if(character==='sun'){
    path('M7 0H11V3H14V5H17V7H18V11H15V14H13V17H10V18H7V15H4V13H1V10H0V7H3V4H5V1H7Z','#efb041');
    path('M6 4H12V6H14V12H12V14H6V12H4V6H6Z','#ffe487','#ac752b');
  }else if(character==='moon'){
    path('M10 1H6V3H4V5H2V12H4V15H7V17H13V15H16V11H12V9H10V6H9V3H10Z','#fff0af','#a88c57');
    rect(4,6,1,2,'#fff9db');
  }else if(character==='cloud'){
    path('M1 9H3V6H6V4H11V6H14V8H16V10H17V14H15V15H3V14H1Z','#d8e9f5','#6d8ba4');
    rect(6,5,4,1,'#fff');
  }else if(character==='drop'){
    path('M8 1H10V4H12V6H14V9H16V13H14V15H12V17H6V15H4V13H2V10H4V7H6V4H8Z','#79cfea','#397795');
    rect(5,9,1,3,'#d9f8ff');
  }else{
    path('M8 0H10V4H12V2H14V4H12V6H14V8H18V10H14V12H16V14H14V12H12V14H10V18H8V14H6V16H4V14H6V12H4V10H0V8H4V6H2V4H4V6H6V4H8Z','#c8efff','#6f9cb7');
    rect(5,6,8,7,'#f6fdff');
  }
  const eyeY=character==='moon'?10:8,left=character==='moon'?4:6,right=character==='moon'?8:11;
  if(['running','background'].includes(state)){rect(left,eyeY,1,2,'#31264e');rect(right,eyeY,1,2,'#31264e');rect(left+2,eyeY+3,2,1,'#31264e');}
  else {for(const x of [left-1,right-1]){rect(x,eyeY+1,1,1,'#31264e');rect(x+1,eyeY,1,1,'#31264e');rect(x+2,eyeY+1,1,1,'#31264e');}rect(left+2,eyeY+3,2,1,'#b55b59');}
  rect(left-2,eyeY+2,2,1,'#f6a0a0');rect(right+1,eyeY+2,2,1,'#f6a0a0');
  if(character==='cloud'&&document.documentElement.dataset.weather==='storm')path('M13 1H17L15 4H18L13 8L14 5H11Z','#ffce54','#997124');
  badge.append(svg);
  if(state==='background'){
    const orbit=element('span','star-orbit');orbit.setAttribute('aria-hidden','true');orbit.append(element('i'),element('i'));badge.append(orbit);
  }else badge.append(element('span','star-effect',state==='running'?'···':document.documentElement.dataset.theme==='real'?'✓':'✦'));
  // Rendering occurs every poll; retain the animation phase across DOM replacement.
  badge.style.setProperty('--star-phase',-(Date.now()/1000%(state==='background'?3:1.8))+'s');
  return badge;
}
const completionGlints=new Map(), usageMotion=new Map(), completionRows=new Map();
function rowCompletion(row){return completionRows.get(row.provider+':'+row.session_id);}
function motionEnabled(){return ['night','real'].includes(document.documentElement.dataset.theme)&&!matchMedia('(prefers-reduced-motion: reduce)').matches;}
function usagePosition(motion,now){
  const t=Math.min(1,Math.max(0,(now-motion.started)/700));
  return motion.from+(motion.to-motion.from)*(1-(1-t)**3);
}
const batteryReadings=new Map();
function pixelBattery(value,stale,key){
  const now=performance.now(),old=batteryReadings.get(key);
  const current={value,fresh:!stale&&Number.isFinite(value),blink:old?.blink};
  if(old?.fresh&&current.fresh&&old.value!==value)current.blink=now;
  if(!current.fresh)current.blink=undefined;
  batteryReadings.set(key,current);
  const mood=!current.fresh?'unknown':value>50?'happy':value>20?'steady':'sleepy';
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox','0 0 22 20');svg.setAttribute('aria-hidden','true');svg.classList.add('pixel-battery',mood);
  const rect=(x,y,w,h,cls)=>{const r=document.createElementNS(ns,'rect');for(const [k,v] of Object.entries({x,y,width:w,height:h,class:cls}))r.setAttribute(k,v);svg.append(r);};
  rect(3,3,16,14,'battery-outline');rect(19,7,2,6,'battery-outline');rect(4,4,14,12,'battery-body');
  rect(5,5,2,10,'battery-shine');
  if(mood==='unknown'){
    const t=document.createElementNS(ns,'text');t.setAttribute('x','9');t.setAttribute('y','14');t.setAttribute('class','battery-question');t.textContent='?';svg.append(t);
  }else{
    for(const x of [9,14])rect(x,8,1,mood==='sleepy'?1:2,'battery-eyes');
    rect(11,12,3,1,'battery-face');if(mood==='happy'){rect(10,11,1,1,'battery-face');rect(14,11,1,1,'battery-face');}
  }
  if(current.blink!==undefined&&now-current.blink<650){svg.classList.add('battery-blink');svg.style.setProperty('--battery-delay',-(now-current.blink)+'ms');}
  return svg;
}
function animateUsage(bar,key,value,stale,gauge,meter,baseline){
  const now=performance.now(),previous=usageMotion.get(key);
  let motion=previous;
  if(!previous||previous.to!==value||stale||!motionEnabled()){
    const from=previous&&previous.fresh&&!stale&&motionEnabled()?usagePosition(previous,now):value;
    motion={from,to:value,started:now,fresh:!stale};usageMotion.set(key,motion);
  }
  bar.setAttribute('aria-valuenow',String(value));
  bar.setAttribute('aria-valuetext',value+'% 남음');
  const hasStart=Number.isFinite(baseline)&&baseline>=0&&baseline<=100;
  const description=value+'% 남음'+(hasStart?' · 집계 시작 '+baseline+'% · 해당 한도 구간 감소 '+Math.max(0,baseline-value).toFixed(2)+'%p':'');
  bar.setAttribute('aria-valuetext',description);gauge.setAttribute('aria-valuetext',description);
  if(hasStart){
    const marker=element('span','usage-start');marker.setAttribute('aria-hidden','true');
    marker.style.left=baseline+'%';marker.style.setProperty('--pixel-start','calc((100% - 27px) * '+(baseline/100)+' + '+(Math.max(0,Math.min(9,Math.ceil(baseline/10)-1))*3)+'px)');
    meter.append(marker);
  }
  const spent=element('span','usage-spent');spent.setAttribute('aria-hidden','true');meter.append(spent);
  const draw=position=>{
    bar.value=position;
    spent.style.left=position+'%';spent.style.width=(hasStart?Math.max(0,baseline-position):0)+'%';
    if(gauge)for(const [i,cell] of [...gauge.children].entries()){
      const fill=Math.max(0,Math.min(100,(position-i*10)*10));
      cell.firstChild.style.width=fill+'%';
      const end=hasStart?Math.max(0,Math.min(100,(baseline-i*10)*10)):fill;
      cell.lastChild.style.left=fill+'%';cell.lastChild.style.width=Math.max(0,end-fill)+'%';
    }
  };
  draw(usagePosition(motion,now));
  const frame=()=>{
    if(!bar.isConnected)return;
    draw(motionEnabled()?usagePosition(motion,performance.now()):value);
    if(bar.value!==value)requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
const folderBoard=LocalMonitorFolders.create($('folder-board'),openJournal,selected=>{
  $('workshop-all').setAttribute('aria-pressed',String(selected==='all'));
  document.querySelectorAll('.workshop-room').forEach(room=>{const active=room.dataset.workshopProvider===selected;room.classList.toggle('is-selected',active);for(const b of room.querySelectorAll('.workshop-name,.workshop-scene'))b.setAttribute('aria-pressed',String(active));});
});
const workshop=LocalMonitorWorkshop.create($('workshop-grid'),openJournal,openUsageDetails,usageCardWindows,provider=>folderBoard.select(provider));
$('workshop-all').onclick=()=>{folderBoard.select('all');const settings=$('workshop-all').closest('details');settings.open=false;settings.querySelector('summary').focus();};
function workshopStale(){
  return !!data&&(!!data.collector_error||!!data.snapshot.errors?.length||serverClock.age(data.snapshot.at)>15||connectionFailures>=2||['인증 만료','연결 끊김'].includes($('connection').textContent));
}
function renderWorkshop(){folderBoard.render(data,serverClock.now(),workshopStale());workshopModel=workshop.render(data,serverClock.now(),workshopStale(),connectionFailures>=2||['인증 만료','연결 끊김'].includes($('connection').textContent));}
function openJournal(selected='all',mode='all',sessionId=null){
  provider=selected;filter=mode==='completed'?'all':mode;journalView=mode==='completed'?'completed':'sessions';journalSession=sessionId;query='';$('search').value='';
  $('session-tools').hidden=false;$('details-toggle').setAttribute('aria-expanded','true');
  journalOpener=document.activeElement;if(!$('workshop-dialog').open)$('workshop-dialog').showModal();
  render({usage:false,system:false});
}
$('workshop-open').onclick=()=>{const settings=$('workshop-open').closest('details');settings.open=false;settings.querySelector('summary').focus();openJournal();};
$('workshop-close').onclick=()=>$('workshop-dialog').close();
$('workshop-dialog').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();$('workshop-dialog').close();}},true);
$('workshop-dialog').addEventListener('close',()=>{if(journalOpener?.isConnected)journalOpener.focus();});
$('workshop-dialog').addEventListener('click',e=>{if(e.target!==$('workshop-dialog'))return;const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();});
for(const [id,view] of [['journal-sessions','sessions'],['journal-completed','completed']])$(id).onclick=()=>{journalView=view;journalSession=null;filter='all';render({usage:false,system:false});};
function renderCompletionJournal(){
  const entries=workshopModel?.entries;
  const rows=(entries||[]).filter(e=>(provider==='all'||e.provider===provider)&&(!journalSession||e.session_id===journalSession)&&((e.title||'')+' '+(e.cwd||'')+' '+e.session_id).toLowerCase().includes(query)).sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id));
  $('sessions').replaceChildren();
  if(!rows.length)$('sessions').append(element('div','empty',entries===null?'완료 상태를 확인 중이에요.':'조건에 맞는 최근 완료가 없어요.'));
  for(const e of rows){
    const row=element('div','session is-completed');row.dataset.eventId=e.id;
    const main=element('div','session-main'),info=element('div','session-info');
    info.append(element('div','session-title',e.title||'완료 작업'),element('div','session-meta',name(e.provider)+' · '+(e.cwd?.split('/').filter(Boolean).pop()||'프로젝트 없음')+' · '+e.session_id.slice(0,8)));
    main.append(element('div','provider-icon '+e.provider,e.provider==='claude'?'✳':e.provider==='codex'?'⌘':'✦'),info);
    const time=element('time','session-time',new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(e.at*1000)));time.dateTime=new Date(e.at*1000).toISOString();time.title='한국 시간';
    row.append(main,element('span','badge completed','작업 완료'),time);$('sessions').append(row);
  }
  $('filter-label').textContent=`최근 30분 완료 작업 · ${rows.length}개`;
}
function renderSessionPreview(){
  const host=$('session-preview-detail');
  const row=journalSession?data.snapshot.sessions.find(r=>r.session_id===journalSession&&(provider==='all'||r.provider===provider)):null;
  host.hidden=!row;
  if(!row){host.replaceChildren();host.dataset.signature='';return;}
  const info=LocalMonitorFolders.readPreview(row),signature=JSON.stringify([row.provider,row.session_id,row.status,info]);
  if(host.dataset.signature===signature)return;
  host.dataset.signature=signature;host.replaceChildren(element('h3','','주요 메시지'));
  if(activeStates.has(row.status)){host.append(element('p','','작업이 다시 진행 중이에요. 다음 응답을 기다리고 있어요.'));return;}
  host.append(element('p','session-preview-body',info.text||info.rawSummary));
  if(info.questions.length){
    host.append(element('h3','','선택지 · 읽기용'));
    for(const q of info.questions){
      host.append(element('p','',q.question));const list=element('ol','session-preview-options');
      for(const o of q.options)list.append(element('li','',o.label+(o.description?' — '+o.description:'')));
      host.append(list);
    }
  }
  if(info.truncated)host.append(element('p','muted','긴 응답은 앞 8,000자까지 표시해요. 전체 내용은 원래 대화에서 확인해 주세요.'));
}
function render(parts={}) {
  if(parts.system!==false)renderSystem();
  if(!data)return;
  const sessionScroll=$('sessions').scrollTop;
  const usageScroll=new Map([...document.querySelectorAll('[data-usage-provider]')].map(el=>[el.dataset.usageProvider,el.scrollTop]));
  if(parts.usage!==false)renderUsage(data.usage || []);
  document.querySelectorAll('[data-usage-provider]').forEach(el=>{el.scrollTop=usageScroll.get(el.dataset.usageProvider)||0;});
  renderWorkshop();
  for(const [key,entry] of completionRows){
    const row=data.snapshot.sessions.find(r=>r.provider+':'+r.session_id===key);
    if(performance.now()-entry.started>=10000||!row||!['completed','disconnected'].includes(row.status)||(entry.turn&&row.turn_id&&entry.turn!==row.turn_id))completionRows.delete(key);
  }
  if(parts.sessions===false||!$('workshop-dialog').open)return;
  renderSessionPreview();
  $('journal-sessions').classList.toggle('selected',journalView==='sessions');
  $('journal-completed').classList.toggle('selected',journalView==='completed');
  $('journal-sessions').setAttribute('aria-pressed',String(journalView==='sessions'));
  $('journal-completed').setAttribute('aria-pressed',String(journalView==='completed'));
  document.querySelectorAll('[data-filter]').forEach(b=>b.hidden=journalView==='completed');
  $('workshop-journal-note').textContent=journalView==='completed'?(workshopStale()?'이전 값 · 상태 확인 불가':workshopModel?.partial?'일부 집계 · 완료 시각 미확인 작업은 제외해요.':'도구별 세션당 1개 · 현재 완료 상태이며 마지막 완료가 30분 이내인 작업이에요. 재개하면 제외돼요.'):filter==='historical'?'최근 활동 근거와 현재 프로세스 확인이 없는 기록이에요. 종료된 것으로 단정하지 않으며 현재 배지 집계와 분리해요.':'감지된 세션 범위의 기록이에요. 전체 영구 이력은 아니에요.';
  const all=data.snapshot.sessions;
  const now=Date.now()/1000;
  for(const [key,entry] of completionRows){
    const row=all.find(r=>r.provider+':'+r.session_id===key);
    if(performance.now()-entry.started>=10000||!row||!['completed','disconnected'].includes(row.status)||(entry.turn&&row.turn_id&&entry.turn!==row.turn_id))completionRows.delete(key);
  }
  $('count-active').textContent=all.filter(r=>activeStates.has(r.status)).length;
  $('count-attention').textContent=all.filter(r=>attentionStates.has(r.status)).length;
  $('session-count').textContent=all.length;
  $('updated').textContent=data.snapshot.at?'갱신 '+elapsed(data.snapshot.at):'첫 수집 중';
  let rows=all.filter(r=>(provider==='all'||r.provider===provider)&&(
    filter==='all'||filter==='running'&&activeStates.has(r.status)||filter==='active'&&(activeStates.has(r.status)||attentionStates.has(r.status)||recentCompletion(r,now))||
    filter==='attention'&&attentionStates.has(r.status)||filter==='historical'&&LocalMonitorWorkshop.historicalUnknown(r,serverClock.now()))&&
    (r.title+' '+r.cwd+' '+r.session_id).toLowerCase().includes(query)&&(!journalSession||r.session_id===journalSession));
  rows.sort((a,b)=>sessionActivity(b)-sessionActivity(a)||(a.provider+':'+a.session_id).localeCompare(b.provider+':'+b.session_id));
  $('sessions').replaceChildren();
  if(!rows.length){const empty=element('div','empty');empty.append(element('strong','',filter==='active'?'지금은 진행 중인 작업이 없어요.':'조건에 맞는 대화가 없어요.'),element('span','','필터를 바꾸거나 새 작업을 시작해 보세요.'));$('sessions').append(empty);}
  for(const r of rows){
    const retained=recentCompletion(r,now);
    const displayStatus=retained?'completed':r.status;
    const row=element('div','session'+(displayStatus==='completed'?' is-completed':''));row.dataset.sessionId=r.session_id;row.dataset.sessionProvider=r.provider;row.dataset.status=displayStatus;
    const completion=rowCompletion(r);
    if(completion){
      row.classList.add('new-completion');
      const age=performance.now()-completion.started;
      if(age<3000){row.classList.add('completion-pulse');row.style.setProperty('--completion-delay',-age+'ms');}
    }
    const main=element('div','session-main');main.append(element('div','provider-icon '+r.provider,r.provider==='claude'?'✳':r.provider==='antigravity'?'✦':'⌘'));
    const info=element('div','session-info');const title=element('div','session-title',r.title);title.title=r.title;
    const meta=element('div','session-meta');const project=element('span','project',r.cwd.split('/').filter(Boolean).pop()||'프로젝트 없음');project.title=r.cwd;
    meta.append(element('span','',name(r.provider)),element('span','','·'),project,element('span','id',r.session_id.slice(0,8)));
    info.append(title,meta);main.append(info);
    const badge=element('span','badge '+displayStatus);badge.append(element('i'),document.createTextNode(labels[displayStatus]||'확인 불가'));
    const status=element('div','session-status');status.append(badge);if(['running','completed','background'].includes(displayStatus))status.append(starBadge(displayStatus));if(r.reason)status.title=r.reason;
    const recent=element('div','session-time',elapsed(sessionActivity(r)));
    if(completion){const mark=element('span','completion-new','NEW');mark.setAttribute('aria-label','새 응답 완료');recent.prepend(mark);}
    row.append(main,status,recent);$('sessions').append(row);
  }
  document.querySelectorAll('[data-filter]').forEach(b=>{b.classList.toggle('selected',b.dataset.filter===filter);b.setAttribute('aria-pressed',String(b.dataset.filter===filter));});
  document.querySelectorAll('[data-provider]').forEach(b=>{b.classList.toggle('selected',b.dataset.provider===provider);b.setAttribute('aria-pressed',String(b.dataset.provider===provider));});
  $('filter-label').textContent={active:'진행 중 · 완료 후 20분 유지',attention:'확인이 필요한 세션',all:'보관되지 않은 최근 기록',running:'현재 진행 중인 세션',historical:'지난 미확인 기록 · 종료 여부 미확정'}[filter];
  if(journalView==='completed')renderCompletionJournal();
  $('sessions').scrollTop=sessionScroll;
}
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;journalSession=null;render({usage:false,system:false});});
document.querySelectorAll('[data-provider]').forEach(b=>b.onclick=()=>{provider=b.dataset.provider;journalSession=null;render({usage:false,system:false});});
$('search').oninput=e=>{query=e.target.value.toLowerCase();journalSession=null;render({usage:false,system:false});};
$('details-toggle').onclick=()=>{const open=$('session-tools').hidden;$('session-tools').hidden=!open;$('details-toggle').setAttribute('aria-expanded',String(open));};
let connectionFailures=0;
function connectionIssue(message=''){
  const node=$('connection');node.hidden=!message;node.className='connection'+(message?' offline':'');
  node.replaceChildren();
  if(message)node.append(element('i'),document.createTextNode(message));
}
let stream=null,streamCursor=null,fallbackTimer=null,fallbackActive=false,transportBusy=false,lastMessage=0;
let lastMessageMono=null;
const serverClock=LocalMonitorClock.create();
const messageAge=()=>lastMessageMono===null?null:Math.max(0,performance.now()-lastMessageMono)/1000;
const diagnostics=LocalMonitorDiagnostics.create(()=>{
  const age=serverClock.age(data?.snapshot.at);
  const warning=!$('warning').hidden,connection=$('connection').textContent;
  const reason=!warning?'none':connection==='인증 만료'?'auth':connection==='연결 끊김'?'disconnected':data?.collector_error?'collector':age>15?'stale':data?.snapshot.errors?.length?'sessions':'unknown';
  return {snapshot_at:data?.snapshot.at??null,snapshot_age_s:age,raw_snapshot_age_s:data?.snapshot.at?Date.now()/1000-data.snapshot.at:null,clock_source:serverClock.mode,collector_error:!!data?.collector_error,
    session_error_count:data?.snapshot.errors?.length||0,message_age_s:messageAge(),
    stream:['connecting','open','closed'][stream?.readyState]||'none',fallback:fallbackActive,
    failure_count:connectionFailures,warning,reason};
});
$('diagnostics-download').onclick=()=>diagnostics.download();
$('diagnostics-clear').onclick=()=>diagnostics.clear();
function applyState(next,parts={},baseline=false){
    if(baseline){cursor=null;workshop.reset();folderBoard.reset();}
    if(instance!==next.instance){instance=next.instance;cursor=null;workshop.reset();folderBoard.reset();completionGlints.clear();usageMotion.clear();completionRows.clear();batteryReadings.clear();$('toasts').replaceChildren();}
    const fresh=cursor!==null?next.events.filter(e=>e.seq>cursor):[];
    if(cursor!==null){
      for(const [id,started] of completionGlints)if(performance.now()-started>=900)completionGlints.delete(id);
      if(motionEnabled())for(const e of fresh)completionGlints.set(e.id,performance.now());
      for(const event of fresh){
        completionRows.set(event.provider+':'+event.session_id,{started:performance.now(),turn:event.turn_id});
      }
      if(fresh.length){setTimeout(render,3000);setTimeout(render,10000);}
      for(const event of fresh){
        if('Notification' in window&&Notification.permission==='granted'){
          try { new Notification(name(event.provider)+' · 응답 완료',{body:event.title,tag:event.id}); } catch {}
        }
      }
    }
    cursor=next.seq;data=next;
    const age=serverClock.age(next.snapshot.at);
    const stale=next.collector_error||(age!==null&&age>15);
    connectionFailures=0;connectionIssue(stale?'수집 지연':'');
    const errors=next.snapshot.errors||[];
    $('warning').hidden=!stale&&!errors.length;
    $('warning').textContent=stale?'새 상태를 확인하지 못했어요. 아래 내용은 마지막으로 확인한 기록입니다.':errors.length?'일부 세션을 확인하지 못했어요: '+errors.join(', '):'';
    render(parts);
    if(!workshopStale())workshop.celebrate(fresh,serverClock.now());
    if(parts.usage!==false&&usageDetailProvider)loadUsageDetails();
}
function transportError(error){
  if(error.message==='auth_required'){
    connectionIssue('인증 만료');const login=element('a','','다시 로그인 ↗');login.href='/';
    $('warning').hidden=false;$('warning').replaceChildren(document.createTextNode('접근 인증이 필요해요. '),login);renderWorkshop();return;
  }
  if(++connectionFailures<2)return;
  connectionIssue('연결 끊김');$('warning').hidden=false;
  $('warning').textContent='로컬 모니터와 연결이 끊겼어요. 마지막 상태를 유지하며 다시 연결하고 있습니다.';renderWorkshop();
}
async function fetchJSON(url){
  const started=performance.now(),wall=Date.now(),endpoint=url.startsWith('/api/usage/')?'usage':'state';
  let status=0;
  try{
    const response=await fetch(url,{cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(5000)});status=response.status;
    if(response.type==='opaqueredirect'||response.status===401||response.status===403)throw new Error('auth_required');
    if(!response.ok)throw new Error('unavailable');
    const result=await response.json(),duration=performance.now()-started,date=Date.parse(response.headers.get('Date'));
    if(endpoint==='state'){
      if(Number.isFinite(result.server_time))serverClock.sync(result.server_time,duration);
      else if(Number.isFinite(date))serverClock.sync(date/1000,duration,'http_date');
    }
    diagnostics.record('http_ok',{endpoint,http_status:status,duration_ms:duration,server_clock_offset_ms:Number.isFinite(date)?date-(wall+duration/2):null});
    return result;
  }catch(error){
    const reason=['TimeoutError','AbortError'].includes(error.name)?'timeout':error.message==='auth_required'?'auth':error.name==='SyntaxError'?'invalid_json':error.name==='TypeError'?'network':'unavailable';
    diagnostics.record('http_error',{endpoint,http_status:status,duration_ms:performance.now()-started,reason},true);throw error;
  }
}
async function pollFallback(){
  if(transportBusy)return;
  transportBusy=true;
  const startedCursor=streamCursor;
  try{
    const next=await fetchJSON('/api/state');
    // Ignore a fallback response overtaken by a newer stream event.
    if(startedCursor===streamCursor){
      streamCursor=next.stream_id||null;
      const parts={system:true,usage:JSON.stringify(data?.usage)!==JSON.stringify(next.usage),sessions:JSON.stringify(data?.snapshot.sessions)!==JSON.stringify(next.snapshot.sessions)||data?.seq!==next.seq||JSON.stringify(data?.completion_window)!==JSON.stringify(next.completion_window)};
      applyState(next,parts);
    }
    if(!stream)connectStream();
  }catch(error){transportError(error);}
  finally{transportBusy=false;if(fallbackActive){clearTimeout(fallbackTimer);fallbackTimer=setTimeout(pollFallback,5000);}}
}
function startFallback(){
  fallbackActive=true;
  if(!fallbackTimer&&!transportBusy)fallbackTimer=setTimeout(()=>{fallbackTimer=null;pollFallback();},1000);
}
function connectStream(){
  if(!window.EventSource){startFallback();return;}
  const source=new EventSource('/api/stream'+(streamCursor?'?cursor='+encodeURIComponent(streamCursor):''));stream=source;
  const alive=()=>{if(stream!==source)return false;lastMessage=Date.now();lastMessageMono=performance.now();fallbackActive=false;clearTimeout(fallbackTimer);fallbackTimer=null;return true;};
  source.addEventListener('reset',event=>{
    if(!alive())return;
    diagnostics.record('sse_reset');
    try{const next=JSON.parse(event.data);serverClock.observe(next.server_time);streamCursor=event.lastEventId;applyState(next,{},true);}catch{diagnostics.record('sse_parse_error',{reason:'invalid_json'},true);source.close();stream=null;startFallback();}
  });
  source.addEventListener('patch',event=>{
    if(!alive())return;
    try{
      if(!data)throw Error('missing baseline');
      if(streamCursor&&event.lastEventId.split(':')[0]===streamCursor.split(':')[0]&&Number(event.lastEventId.split(':')[1])<=Number(streamCursor.split(':')[1]))return;
      const patch=JSON.parse(event.data);
      serverClock.observe(patch.server_time);
      const next={...data,...patch,snapshot:patch.snapshot||{...data.snapshot}};
      if(patch.system_history_change){
        const change=patch.system_history_change,points=new Map((data.system_history||[]).map(p=>[p.at,p]));
        for(const p of change.upsert)points.set(p.at,p);
        next.system_history=change.after===null?[]:[...points.values()].filter(p=>p.at>=change.after&&p.at<=change.through).sort((a,b)=>a.at-b.at).slice(-180);
        delete next.system_history_change;
      }
      if(patch.session_changes){
        const change=patch.session_changes,key=r=>r.provider+':'+r.session_id;
        const rows=new Map(data.snapshot.sessions.map(r=>[key(r),r]));
        for(const pair of change.remove)rows.delete(pair.join(':'));
        for(const row of change.upsert)rows.set(key(row),row);
        next.snapshot={at:change.at,errors:change.errors,sessions:[...rows.values()]};
        delete next.session_changes;
      }
      if(patch.snapshot_at!==undefined)next.snapshot.at=patch.snapshot_at;
      delete next.snapshot_at;
      streamCursor=event.lastEventId;
      applyState(next,{system:'system' in patch||'system_history_change' in patch,usage:'usage' in patch,sessions:'snapshot' in patch||'session_changes' in patch||'events' in patch||'seq' in patch||'completion_window' in patch});
    }catch{diagnostics.record('sse_parse_error',{reason:'invalid_json'},true);source.close();stream=null;streamCursor=null;startFallback();}
  });
  source.addEventListener('heartbeat',event=>{
    if(!alive())return;
    try{serverClock.observe(JSON.parse(event.data).server_time);}catch{diagnostics.record('sse_parse_error',{reason:'invalid_json'},true);}
    if(data)applyState(data,{system:false,usage:false,sessions:false});
  });
  source.onopen=()=>{lastMessage=Date.now();lastMessageMono=performance.now();diagnostics.record('sse_open');};
  source.onerror=()=>{if(stream===source){startFallback();diagnostics.record('sse_error',{},true);}};
}
setInterval(()=>{
  if(stream&&messageAge()>25){diagnostics.record('sse_watchdog',{},true);stream.close();stream=null;startFallback();}
},5000);
function beginTransport(){fallbackActive=true;pollFallback();}

function tick(){
  const now=new Date(),parts=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const value=key=>parts.find(p=>p.type===key)?.value||'';
  $('clock').textContent=value('month')+'월 '+value('day')+'일 ('+value('weekday')+') '+value('hour')+':'+value('minute');
  $('clock').dateTime=now.toISOString();
}

function tickLocal(){
  tick();renderSystem();if(!data)return;
  $('updated').textContent=data.snapshot.at?'갱신 '+elapsed(data.snapshot.at):'첫 수집 중';
  for(const card of document.querySelectorAll('.usage-card')){
    const row=data.usage.find(r=>r.provider===card.dataset.usageProvider);
    for(const node of card.querySelectorAll('.usage-reset[data-window-id]')){
      const w=row?.windows.find(x=>x.id===node.dataset.windowId);
      if(w)node.textContent=usageResetText(w,!!node.dataset.short);
    }
  }
  let expired=false;
  for(const node of document.querySelectorAll('.session')){
    const row=data.snapshot.sessions.find(r=>r.provider===node.dataset.sessionProvider&&r.session_id===node.dataset.sessionId);
    if(!row)continue;
    if(filter==='active'&&node.dataset.status==='completed'&&!recentCompletion(row))expired=true;
    const time=node.querySelector('.session-time'),label=elapsed(sessionActivity(row));
    if(time){const mark=time.querySelector('.completion-new');if(mark)time.replaceChildren(mark,document.createTextNode(label));else time.textContent=label;}
  }
  if(expired)render({usage:false,system:false});
  if(usageDetailProvider)renderUsageDetails();
}
tick();setInterval(tickLocal,10000);setInterval(()=>{if(!data)return;const before=workshopModel?.entries?.length;renderWorkshop();if($('workshop-dialog').open&&journalView==='completed'&&before!==workshopModel?.entries?.length)render({usage:false,system:false});},1000);permission();beginTransport();

// Weekly first; Antigravity keeps each family (e.g. Gemini + Argon) together.
function usageWindows(row){
  const windows=[...(row?.windows||[])],groups=[...new Set(windows.map(w=>w.group))];
  const family=w=>row.provider==='antigravity'?groups.indexOf(w.group):0;
  return windows.sort((a,b)=>family(a)-family(b)||(b.label==='주간')-(a.label==='주간')||!!a.name-!!b.name);
}
// Antigravity card: each family's 5-hour window rides on its weekly line to save height.
function usageCardWindows(row){
  const windows=usageWindows(row);
  if(row?.provider!=='antigravity')return windows;
  const short=w=>w.label==='5시간'&&!w.name,base=w=>w.label==='주간'&&!w.name;
  const merged=new Map(windows.filter(short).filter(w=>windows.some(x=>base(x)&&x.group===w.group)).map(w=>[w.group,w]));
  return windows.filter(w=>!(short(w)&&merged.get(w.group)===w)).map(w=>base(w)&&merged.has(w.group)?{...w,merged:merged.get(w.group)}:w);
}
function usageResetText(w,short){
  const text=usageTiming(w).reset;
  return short?text.replace('초기화까지 ',''):text;
}
function usageWindowTitle(w){
  return w.label+(w.group==='전체'||w.group==='codex'?'':' · '+w.group)+(w.name?' '+w.name:'');
}
function usageTiming(w,now=Date.now()/1000){
  const seconds=Number.isFinite(w.resets_at)?w.resets_at-now:null;
  let reset='초기화 시각 정보 없음';
  if(seconds!==null){
    if(seconds<=0)reset='초기화 확인 중';
    else if(seconds>=86400)reset='초기화까지 '+Math.floor(seconds/86400)+'d '+Math.floor(seconds%86400/3600)+'h';
    else if(seconds>=60)reset='초기화까지 '+Math.floor(seconds/3600)+'h '+Math.floor(seconds%3600/60)+'m';
    else reset='초기화까지 1m 미만';
  }
  const valid=Number.isFinite(w.remaining_percent)&&w.remaining_percent>=0&&w.remaining_percent<=100;
  const daily=w.label==='주간'&&seconds>0&&valid ? (seconds>=86400?w.remaining_percent/(seconds/86400):w.remaining_percent):null;
  return {seconds,reset,daily,budget:daily===null?'':(seconds>=86400?'하루 권장 ':'초기화 전 ')+new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(daily)+'%'};
}
function dailySummary(w){
  const d=w.daily;
  if(!d||d.status==='waiting')return '오늘 집계 대기';
  if(d.status==='account_unknown')return '일일 집계 · 계정 확인 필요';
  const fmt=v=>new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(v);
  return '오늘'+(d.partial||d.missing?'*':'')+' '+fmt(d.used)+' / 권장 '+(d.recommended===null?'—':fmt(d.recommended))+'%p'+(d.status==='delayed'?' · 지연':'');
}
function appendDailyDetails(section,w){
  if(w.label!=='주간')return;
  const d=w.daily;
  if(!d||['waiting','account_unknown'].includes(d.status)){section.append(element('p','usage-calculation',d?.status==='account_unknown'?'계정을 구분할 수 없어 일일 집계를 보류하고 있어요.':'오전 6시 이후 첫 정상 관측을 기다리고 있어요.'));return;}
  const fmt=v=>new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(v)+'%p';
  const list=element('dl','daily-details');
  const pair=(label,value)=>list.append(element('dt','',label),element('dd','',value));
  pair('사용일 · KST',usageExactDate(d.day_start)+' ~ '+usageExactDate(d.day_end));
  pair('집계 시작',usageExactDate(d.started_at));pair('오늘 사용',fmt(d.used));
  pair('오늘 권장',d.recommended===null?'확인 필요':fmt(d.recommended));
  if(d.available!==null)pair(d.available>=0?'오늘 여유':'권장 초과',fmt(Math.abs(d.available)));
  const preReset=d.pre_reset||[];
  if(preReset.length)pair('리셋 전 사용',fmt(preReset.reduce((sum,s)=>sum+s.used,0)));
  section.append(list);
  const resetObservedAt=d.quota_reset_at??d.early_reset_at;
  const notices=[Number.isFinite(resetObservedAt)?'주간 한도가 초기화되거나 회복돼 '+usageExactDate(resetObservedAt)+' 관측부터 새 주기로 다시 계산했어요. 리셋 전 사용량은 오늘 합계와 권장량에서 제외돼요.':d.partial?'첫 관측 시각부터 집계해요. 그 이전 사용량은 포함되지 않아요.':'',d.missing?'초기화 또는 한도 변경 전후 일부 구간이 미집계됐어요.':'',d.status==='delayed'?'집계 지연 · 마지막 관측값을 유지하고 있어요.':'',d.storage_error?'집계 저장 실패 · 재시작하면 기록이 유실될 수 있어요.':''].filter(Boolean);
  if(notices.length)section.append(element('p','usage-detail-warning',notices.join(' ')));
  const breakdown=element('details','daily-breakdown');breakdown.append(element('summary','','권장량 계산 · 전체 주간 한도 기준'));
  for(const segment of d.segments||[]){const hours=(segment.allocation_seconds/3600).toFixed(2),total=(segment.reset_seconds/3600).toFixed(2);breakdown.append(element('p','usage-calculation',usageExactDate(segment.started_at)+' · '+(segment.budget===null?'초기화 시각 확인 필요':segment.baseline+'% × '+hours+'시간 ÷ '+total+'시간 ≈ '+fmt(segment.budget))));}
  for(const segment of preReset)breakdown.append(element('p','usage-calculation','리셋 전 · '+usageExactDate(segment.started_at)+' · 잔여 '+segment.baseline+'% → '+segment.lowest+'% · 사용 '+fmt(segment.used)+' (오늘 합계 제외)'));
  section.append(breakdown);
}

function usageExactDate(at){
  return Number.isFinite(at)&&at>0?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at*1000))+' · 한국 시간':'정보 없음';
}
let usageDetailOpener=null;
async function loadUsageDetails(){
  if(!usageDetailProvider)return;
  const provider=usageDetailProvider,request=++usageDetailRequest;
  try{
    const row=await fetchJSON('/api/usage/'+encodeURIComponent(provider));
    if(request!==usageDetailRequest||usageDetailProvider!==provider)return;
    usageDetailRow=row;renderUsageDetails();
  }catch(error){
    if(request!==usageDetailRequest||usageDetailProvider!==provider)return;
    $('usage-dialog-content').replaceChildren(element('p','usage-detail-warning',error.message==='auth_required'?'접근 인증이 필요해요. 페이지를 새로고침해 로그인해 주세요.':'상세 정보를 가져오지 못했어요. 팝업을 다시 열어 주세요.'));
  }
}
function openUsageDetails(provider){
  usageDetailOpener=document.activeElement;usageDetailProvider=provider;usageDetailRow=null;$('usage-dialog-content').dataset.signature='';
  renderUsageDetails();$('usage-dialog').showModal();loadUsageDetails();
}
function claudeRefreshMessage(row){
  const r=row.auth_refresh;
  if(r?.status==='running')return '토큰 만료 · CLI 자동 갱신 중';
  if(r?.status==='disabled')return '토큰 만료 · 자동 갱신 꺼짐';
  if(r?.status==='storage_error')return '토큰 만료 · 갱신 기록 확인 필요';
  if(Number.isFinite(r?.next_at)&&r.next_at*1000>Date.now())return '토큰 만료 · 갱신 재시도 대기';
  return '토큰 만료 · 자동 갱신 대기';
}
function renderUsageDetails(){
  if(!usageDetailProvider)return;
  const row=usageDetailRow,body=$('usage-dialog-content'),scrollTop=$('usage-dialog').scrollTop;
  const signature=JSON.stringify([row,Math.floor(Date.now()/60000)]);
  if(body.dataset.signature===signature)return;body.dataset.signature=signature;
  $('usage-dialog-title').textContent=({codex:'Codex',claude:'Claude Code',antigravity:'Antigravity'}[usageDetailProvider]||usageDetailProvider)+' · 사용량 상세';
  body.replaceChildren();
  if(!row){body.append(element('p','','상세 정보 불러오는 중…'));return;}
  const old=row.status==='stale'||!!row.error;
  if(old)body.append(element('p','usage-detail-warning','최신 값을 확인하지 못했어요. 표시된 값과 권장량은 이전 값 기준입니다.'));
  if(row.provider==='claude'&&row.error==='auth_expired')body.append(element('p','usage-detail-warning',claudeRefreshMessage(row)+'. CLI의 짧은 Haiku 요청으로 갱신을 시도하며 소량의 사용량이 발생해요. 시도는 최대 55초, 최소 1시간 간격이에요. 15초마다 자격 증명을 다시 확인하며 직접 CLI에서 갱신해도 자동 복구돼요.'+(Number.isFinite(row.auth_refresh?.next_at)?' 다음 자동 시도 가능 · '+usageExactDate(row.auth_refresh.next_at):'')));
  if(row.provider==='claude'&&row.error==='auth_required')body.append(element('p','usage-detail-warning','자격 증명이 없거나 사용량 API가 인증을 거부했어요. CLI 로그인 상태를 확인하고 필요하면 claude auth login --claudeai를 실행해 주세요.'));
  for(const w of usageWindows(row)){
    const section=element('section','usage-detail-window'),timing=usageTiming(w);
    section.append(element('h3','',usageWindowTitle(w)));
    const list=element('dl');
    const pair=(label,value)=>list.append(element('dt','',label),element('dd','',value));
    pair('남은 사용량',new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(w.remaining_percent)+'%');
    pair('남은 시간',timing.reset.replace('초기화까지 ',''));pair('초기화 예정',usageExactDate(w.resets_at));section.append(list);
    appendDailyDetails(section,w);
    body.append(section);
  }
  if(!row.windows.length)body.append(element('p','','확인된 한도 정보가 없어요.'));
  body.append(element('p','usage-detail-observed','마지막 확인 · '+usageExactDate(row.observed_at)));
  $('usage-dialog').scrollTop=scrollTop;
}
$('usage-dialog-close').onclick=()=>$('usage-dialog').close();
$('usage-dialog').addEventListener('click',e=>{if(e.target!==$('usage-dialog'))return;const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();});
$('usage-dialog').addEventListener('close',()=>{const provider=usageDetailProvider;usageDetailProvider=null;usageDetailRow=null;usageDetailRequest++;(usageDetailOpener?.isConnected?usageDetailOpener:[...document.querySelectorAll('.usage-card')].find(c=>c.dataset.usageProvider===provider))?.focus({preventScroll:true});usageDetailOpener=null;});

function renderUsage(rows) {
  const names={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity'};
  const errors={auth_expired:'토큰 만료 · CLI 갱신 대기',auth_required:'CLI에서 다시 로그인해 주세요.',auth_or_rpc_error:'Codex 로그인 또는 사용량 조회를 확인해 주세요.',rate_limited:'조회 제한',awaiting_cli:'Antigravity CLI를 열고 /usage를 실행하면 연결돼요.',timeout:'조회 시간이 초과됐어요.',read_failed:'사용량을 읽지 못했어요.',http_error:'사용량 서버에 연결하지 못했어요.'};
  const focusedProvider=document.activeElement?.closest('.usage-card')?.dataset.usageProvider;
  $('usage').replaceChildren();
  document.querySelectorAll('.integrated-usage').forEach(slot=>slot.replaceChildren());
  for(const row of rows){
    const errorMessage=row.provider==='claude'&&row.error==='auth_expired'?claudeRefreshMessage(row):errors[row.error];
    const card=element('article','usage-card');card.dataset.usageProvider=row.provider;card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-haspopup','dialog');card.setAttribute('aria-label',(names[row.provider]||row.provider)+' 사용량 상세');
    card.onclick=()=>{if(!window.getSelection()?.toString())openUsageDetails(row.provider);};card.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openUsageDetails(row.provider);}};
    const heading=element('div','usage-card-heading');heading.append(element('h3','',names[row.provider]||row.provider),element('span','usage-status '+row.status,{ok:'확인됨',stale:'이전 값',loading:'조회 중',unavailable:'확인 필요'}[row.status]||'확인 필요'));card.append(heading);heading.querySelector('.usage-status').title=heading.querySelector('.usage-status').textContent;
    if(!row.windows.length)heading.querySelector('h3').append(pixelBattery(null,true,row.provider+':unknown'));
    if(!row.windows.length)card.append(element('p','usage-empty',row.status==='loading'?'사용량을 조회하고 있어요.':errorMessage||'이 계정의 한도 정보가 아직 없어요.'));
    let windowIndex=0;const ordered=usageCardWindows(row),primaryGroup=ordered[0]?.group;
    for(const w of ordered){
      const secondary=windowIndex++>0;
      // Weekly windows of the primary family (e.g. Gemini Argon) keep a full bar.
      const extra=secondary&&w.label==='주간'&&w.group===primaryGroup;
      const line=element('div','usage-window'+(w.stale?' stale':'')+(secondary?' usage-secondary':' usage-primary')+(extra?' usage-extra':'')+(w.merged?' usage-merged-line':''));
      // Antigravity has no account identity, so its daily line would always read '계정 확인 필요'.
      const showBudget=w.label==='주간'&&!secondary&&!(row.provider==='antigravity'&&w.daily?.status==='account_unknown');
      const inlineReset=false;
      const fmtPercent=v=>new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(v)+'%';
      const reset=(short)=>{const node=element('span','usage-reset'+(short?' usage-reset-inline':''),usageResetText(w,short));node.dataset.windowId=w.id;if(short)node.dataset.short='1';node.title=usageTiming(w).reset;return node;};
      const merged=w.merged&&element('span','usage-merged'+(w.merged.stale?' stale':''),(w.merged.stale?'⚠ ':'')+w.merged.label+' '+fmtPercent(w.merged.remaining_percent));
      if(merged)merged.title=w.merged.label+' · '+usageTiming(w.merged).reset;
      // Merged rows tag the period so narrow cards can drop it (the 5-hour value marks the weekly one).
      const heading=element('span','',w.merged?'':usageWindowTitle(w));if(w.merged)heading.append(element('span','usage-period',w.label+' · '),usageWindowTitle(w).slice((w.label+' · ').length));if(inlineReset)heading.append(reset(true));if(merged&&!secondary)heading.append(merged);
      const title=element('div','usage-window-title');title.append(heading,element('strong','',(w.stale?'⚠ ':'')+fmtPercent(w.remaining_percent)));title.querySelector('strong').prepend(pixelBattery(w.remaining_percent,w.stale,row.provider+':'+w.id));if(merged&&secondary)title.append(merged);heading.title=heading.textContent;if(!secondary)heading.textContent=w.label;line.append(title);
      const label=names[row.provider]+' '+usageWindowTitle(w)+' 남은 사용량';
      const gauge=element('div','energy-gauge');gauge.setAttribute('role','progressbar');gauge.setAttribute('aria-label',label);gauge.setAttribute('aria-valuemin','0');gauge.setAttribute('aria-valuemax','100');gauge.setAttribute('aria-valuenow',String(w.remaining_percent));
      for(let i=0;i<10;i++){const cell=element('span','energy-cell');cell.append(element('b'),element('i','energy-spent'));gauge.append(cell);}
      const meter=element('div','usage-meter'),bar=element('progress','usage-progress');bar.max=100;meter.append(bar,gauge);
      animateUsage(bar,row.provider+':'+w.id,w.remaining_percent,w.stale,gauge,meter,w.daily?.gauge_baseline);bar.setAttribute('aria-label',label);
      const daily=w.daily,segmentUsed=daily?.segments?.at(-1)?.used??daily?.gauge_used;
      if(w.label==='주간'&&!secondary&&!w.stale&&daily?.status==='ok'&&Number.isFinite(daily.gauge_baseline)&&Number.isFinite(daily.recommended)&&daily.recommended>=0&&Number.isFinite(segmentUsed)&&Number.isFinite(daily.used)){
        const previousUsed=daily.used-segmentUsed;
        const threshold=Math.max(0,Math.min(100,daily.gauge_baseline-Math.max(0,daily.recommended-previousUsed)));
        const fmt=v=>new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(v);
        const description='권장 '+fmt(daily.recommended)+'%p 사용 시 잔여 '+fmt(threshold)+'%';
        const marker=element('span','usage-recommendation'+(daily.available<0?' over-budget':''));
        marker.style.left=threshold+'%';marker.style.setProperty('--pixel-recommendation','calc((100% - 27px) * '+threshold/100+' + '+Math.max(0,Math.min(9,Math.ceil(threshold/10)-1))*3+'px)');
        marker.title=description;marker.setAttribute('aria-hidden','true');meter.append(marker);
        const legend=element('span','usage-recommendation-label','┊ 권장선 · 잔여 '+fmt(threshold)+'%');legend.title=description;line.append(legend);
        for(const target of [bar,gauge])target.setAttribute('aria-valuetext',target.getAttribute('aria-valuetext')+' · '+description);
      }
      line.append(meter);
      if(!inlineReset){
        const meta=element('small','usage-budget-row');
        if(showBudget){const budget=element('span','usage-budget',dailySummary(w));budget.title=budget.textContent;if(!secondary&&Number.isFinite(w.daily?.used)){budget.textContent='오늘 사용 '+(w.daily.partial||w.daily.missing?'*':'')+new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(w.daily.used)+'%p'+(w.daily.status==='delayed'?' · 지연':'');}if(w.daily?.available<0)budget.classList.add('over-budget');meta.append(budget);}
        meta.append(reset(!!merged));line.append(meta);
      }
      card.append(line);
    }
    const needsLogin=row.provider==='claude'&&row.error==='auth_required';
    if(needsLogin){
      card.classList.add('needs-login');
      const help=element('div','usage-login');
      help.append(element('span','','터미널에서 다시 로그인'));
      help.append(element('code','','claude auth login --claudeai'));
      help.append(element('small','','로그인 후 5분 이내 자동 재조회'));
      card.append(help);
    }
    const warning=row.status==='stale'||!!row.error;
    const note=(row.error?errorMessage||'갱신 실패':row.status==='stale'?'이전 값':'확인')+' · '+(row.observed_at?elapsed(row.observed_at):'수신 대기');
    const retry=row.error==='rate_limited'&&Number.isFinite(row.next_retry_at)?' · '+(row.next_retry_at*1000>Date.now()?Math.ceil((row.next_retry_at*1000-Date.now())/60000)+'분 후 재조회':'재조회 대기'):'';
    const foot=element('div','usage-foot'+(warning?' warning':''));foot.append(element('span','',note+retry),element('span','usage-detail-hint','상세 ›'));card.append(foot);
    const controls=element('div','console-controls');controls.setAttribute('aria-hidden','true');
    controls.append(element('i','console-pad'),element('i','console-speaker'),element('i','console-buttons'));card.append(controls);
    const slot=[...document.querySelectorAll('.integrated-usage')].find(el=>el.dataset.quotaProvider===row.provider);
    (slot||$('usage')).append(card);
    if(focusedProvider===row.provider)card.focus({preventScroll:true});
  }
  if(usageDetailProvider)renderUsageDetails();
}

document.addEventListener('weatherchange',render);
document.addEventListener('themechange',render);

function renderSystem(){
  const s=data?.system,systemAge=serverClock.age(s?.observed_at),ok=s?.status==='ok'&&systemAge!==null&&systemAge<=30;
  const known=Number.isFinite(s?.observed_at)&&['cpu_percent','memory_percent','swap_used'].some(k=>Number.isFinite(s?.[k]));
  const previous=known&&!ok,age=known?Math.floor(systemAge??0):0;
  const ageText=age<60?age+'초 전':elapsed(s.observed_at);
  const pct=v=>Number.isFinite(v)?Math.round(v)+'%':'—';
  const gb=v=>Number.isFinite(v)?(v/1024**3).toFixed(1)+' GiB':'—';
  $('system-state').textContent=ok?'실시간':previous?'이전 값':'확인 대기';
  $('system-chip').classList.toggle('system-stale',previous);
  const history=(data?.system_history||[]).filter(p=>p.at>=Date.now()/1000-1800);
  const graphs=$('system-graphs');graphs.replaceChildren();
  const now=Date.now()/1000;
  for(const [key,label,format] of [['cpu_percent','CPU',pct],['memory_percent','RAM',pct],['swap_used','SWAP',gb]]){
    const row=element('span','system-metric '+key),head=element('span','system-metric-heading');
    head.append(element('span','',label),element('strong','',known?format(s[key]):'—'));row.append(head);
    const finite=history.filter(p=>Number.isFinite(p[key]));
    const limit=key==='swap_used'?Math.max(1024**3,Math.ceil(Math.max(0,...finite.map(p=>p[key]))/1024**3)*1024**3):100;
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 200 21');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('role','img');
    svg.setAttribute('aria-label',label+' 최근 30분 추이 · 0~'+(key==='swap_used'?gb(limit):'100%'));
    const title=document.createElementNS(svg.namespaceURI,'title');title.textContent=svg.getAttribute('aria-label');svg.append(title);
    let path='',last=null;
    for(const point of history){
      if(!Number.isFinite(point[key])){last=null;continue;}
      const x=Math.max(0,Math.min(200,(point.at-(now-1800))/1800*200)),y=20-Math.max(0,Math.min(1,point[key]/limit))*18;
      path+=(last!==null&&point.at-last<=15?' L':' M')+x.toFixed(2)+' '+y.toFixed(2);
      // A single sample remains visible without implying earlier history.
      if(last===null)path+=' l0.2 0';
      last=point.at;
    }
    const line=document.createElementNS(svg.namespaceURI,'path');line.setAttribute('d',path);line.setAttribute('fill','none');line.setAttribute('stroke','currentColor');line.setAttribute('stroke-width','1.5');line.setAttribute('vector-effect','non-scaling-stroke');svg.append(line);row.append(svg);graphs.append(row);
  }
  $('system-history-note').textContent=previous?'이전 값 · '+ageText:history.length?'최근 30분 · 10초 평균':'기록 수집 중 · 10초 평균';
  $('system-chip').classList.toggle('system-alert',!!(ok&&(s.cpu_high||['warning','critical'].includes(s.memory_pressure))));
  $('system-chip').title=previous?'마지막 정상 수집 값 · '+ageText+' · 그래프는 최근 30분':ok?'이 Mac의 CPU·메모리·스왑 상태':'시스템 정보 확인 대기';
  if(!$('system-dialog').open)return;
  const body=$('system-content');body.replaceChildren();
  if(!ok)body.append(element('p','usage-detail-warning',previous?'최신 수집이 지연되어 '+ageText+'의 마지막 정상 값을 표시해요.':'정상 수집 기록이 아직 없어요.'));
  if(s?.last_error){
    const error=s.last_error;
    const stage={cpu:'CPU',memory_total:'메모리 전체 용량',memory:'메모리 사용량',memory_pressure:'메모리 압력',swap:'SWAP'}[error.stage]||'시스템';
    const reason={timeout:'수집 시간 초과',command_failed:'수집 명령 실패',unavailable:'수집 기능 사용 불가',invalid_data:'수집값 해석 실패'}[error.reason]||'수집 오류';
    const at=Number.isFinite(error.at)?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'medium'}).format(new Date(error.at*1000)):'시각 미확인';
    body.append(element('p','usage-calculation','최근 수집 오류 · '+at+' KST · '+stage+' · '+reason+(s.consecutive_failures?' · 연속 '+s.consecutive_failures+'회':' · 이후 정상 수집됨')));
  }
  if(s?.observed_at){
    const dl=element('dl','system-values');
    for(const [label,value] of [['CPU',pct(s.cpu_percent)],['메모리 사용률',pct(s.memory_percent)],['메모리 사용 / 전체',gb(s.memory_used)+' / '+gb(s.memory_total)],['메모리 압력',({normal:'정상',warning:'주의',critical:'높음',unknown:'확인 불가'})[s.memory_pressure]||'확인 불가'],['스왑 사용 / 현재 할당',gb(s.swap_used)+' / '+gb(s.swap_total)],['최근 수집',Math.max(0,Math.floor(Date.now()/1000-s.observed_at))+'초 전']])dl.append(element('dt','',label),element('dd','',value));
    body.append(dl);
  }
  body.append(element('p','usage-calculation','현황판 서버가 실행되는 Mac 전체 · 약 10초마다 수집. 그래프는 10초 단위 평균을 최근 30분까지 표시하며, 서버 재시작 시 기록이 초기화돼요. 빈 구간은 수집 기록이 없는 시간이에요. CPU는 전체 코어 기준 0~100%예요. 메모리는 활성·비활성·유선·압축 페이지에서 파일 캐시·회수 가능 페이지를 뺀 추정치이며, 활동 모니터와 차이가 날 수 있어요. 스왑은 디스크를 메모리 보조 공간으로 사용한 양이에요. 현재 할당 크기는 macOS가 조정하며 고정된 최대 한도가 아니에요.'));
}
try{$('show-system').checked=localStorage.getItem('lm-show-system')!=='false';}catch{}
$('system-chip').hidden=!$('show-system').checked;$('monitor-grid').classList.toggle('without-system',!$('show-system').checked);
$('show-system').onchange=()=>{$('system-chip').hidden=!$('show-system').checked;$('monitor-grid').classList.toggle('without-system',!$('show-system').checked);try{localStorage.setItem('lm-show-system',String($('show-system').checked));}catch{}};
$('system-chip').onclick=()=>{$('system-dialog').showModal();renderSystem();};
$('system-close').onclick=()=>$('system-dialog').close();
$('system-dialog').addEventListener('click',e=>{if(e.target!==$('system-dialog'))return;const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();});
