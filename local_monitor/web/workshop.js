'use strict';
(function(root){
  const providers=['codex','claude','antigravity'];
  const names={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity'};
  const priority={waiting_input:0,failed:1,running:2,background:3};
  const key=r=>JSON.stringify([r.provider,r.session_id]);
  const currentSessions=snapshot=>[...new Map((snapshot?.sessions||[]).map(r=>[key(r),r])).values()];
  function completed(snapshot,now){
    if(!snapshot?.at||!Array.isArray(snapshot.sessions)||!Number.isFinite(now))return null;
    return currentSessions(snapshot).filter(r=>providers.includes(r.provider)&&typeof r.session_id==='string'&&r.session_id&&
      r.status==='completed'&&Number.isFinite(r.completed_at)&&r.completed_at<=now&&r.completed_at>now-1800)
      .map(r=>({...r,id:key(r),at:r.completed_at}));
  }
  function quota(row,now,offline=false){
    const w=row?.windows?.find(w=>w.label==='주간'),d=w?.daily;
    const unknown={percent:null,partial:false,exceeded:false};
    const day=t=>Math.floor((t+10800)/86400); // Existing usage day starts at 06:00 KST.
    if(offline||row?.status!=='ok'||w?.stale||d?.status!=='ok'||!Number.isFinite(now)||
      !Number.isFinite(row?.observed_at)||now-row.observed_at>600||row.observed_at>now+5||day(now)!==day(row.observed_at)||
      !Number.isFinite(d.recommended)||d.recommended<0||!Number.isFinite(d.used)||d.used<0)return unknown;
    return {percent:d.recommended===0?0:Math.max(0,Math.min(100,(d.recommended-d.used)/d.recommended*100)),
      partial:!!(d.partial||d.missing||d.storage_error),exceeded:d.used>d.recommended,overagePercent:d.recommended>0?(d.used-d.recommended)/d.recommended*100:null,used:d.used,recommended:d.recommended};
  }
  function historicalUnknown(row,now){
    return row.status==='unknown'&&row.reason==='no_recent_evidence'&&row.process_verified!==true&&
      Number.isFinite(row.observed_at)&&Number.isFinite(now)&&now-row.observed_at>600;
  }
  function model(state,now){
    const ready=!!state?.snapshot?.at;
    const sessions=currentSessions(state?.snapshot);
    const entries=completed(state?.snapshot,now);
    return {ready,entries,partial:sessions.some(r=>r.status==='completed'&&(!Number.isFinite(r.completed_at)||r.completed_at>now)),rooms:providers.map(provider=>{
      const rows=sessions.filter(r=>r.provider===provider),count=s=>rows.filter(r=>r.status===s).length;
      const running=count('running'),background=count('background'),waiting=count('waiting_input'),failed=count('failed'),unknown=rows.filter(r=>r.status==='unknown'&&!historicalUnknown(r,now)).length;
      const historical=rows.filter(r=>historicalUnknown(r,now)).length;
      return {provider,active:running+background,background,waiting,failed,unknown,historical,
        done:entries===null?null:entries.filter(e=>e.provider===provider).length,
        pose:!ready?'loading':running?'working':background?'background':waiting?'waiting':failed?'failed':unknown?'unknown':'sleeping',
        jobs:rows.filter(r=>r.status in priority).sort((a,b)=>priority[a.status]-priority[b.status]||key(a).localeCompare(key(b)))};
    })};
  }
  // Vehicle appearance settles for three seconds; observed counts never wait.
  function vehicleState(previous,active,moving,now){
    const target=active>=4?3:active>=2?2:1;
    if(!moving||!Number.isFinite(now))return {tier:previous?.tier||1,pending:null,since:null};
    if(!previous)return {tier:target,pending:null,since:null};
    if(target===previous.tier)return {tier:target,pending:null,since:null};
    if(previous.pending!==target||now<previous.since)return {tier:previous.tier,pending:target,since:now};
    return now-previous.since>=3?{tier:target,pending:null,since:null}:previous;
  }
  const vehicleNames={codex:['전동 외바퀴','탐사 로버','소형 우주선'],claude:['킥보드','캠핑카','프로펠러 비행선'],antigravity:['호버보드','호버카','로켓']};
  function vehicle(provider){
    const wheel=(x,y,r=6)=>`<g class="ride-wheel"><circle cx="${x}" cy="${y}" r="${r}" fill="#293d4d"/><circle cx="${x}" cy="${y}" r="${r-2}" fill="#adbbc1"/><path d="M${x-3} ${y}h6M${x} ${y-3}v6" stroke="#445c68" stroke-width="2"/></g>`;
    const jet='<path class="ride-jet" d="M23 57L8 61l15 4z" fill="#8de4dc"/><path class="ride-boost" d="M23 58L3 61l20 3z" fill="#ffe7a4"/>';
    const lamp='<rect class="ride-lamp" x="73" y="56" width="4" height="3" rx="1" fill="#ffe8a1"/>';
    const body=provider==='codex'?[
      `<path fill="#5a9296" d="M39 61h19v5H39zM55 51h4v13h-4z"/><path stroke="#9de3d0" stroke-width="3" d="M54 51h10"/>${wheel(48,69,8)}`,
      `<path fill="#426878" d="M24 53h45l10 8v9H22V57z"/><path fill="#79b7b0" d="M25 53h43v5H25z"/><path fill="#c0edda" d="M63 51h6l5 8H63z"/><path fill="#243f50" d="M28 61h19v5H28z"/>${wheel(31,70)}${wheel(65,70)}${lamp}`,
      `${jet}<path fill="#52788c" d="M25 53h39l18 10-18 8H24l7-9z"/><path fill="#91d9cf" d="M33 52h28l8 7H33z"/><path fill="#314b66" d="M39 64l-7 11h23l7-11z"/><path fill="#d4f1e7" d="M69 59l13 4-13 4z"/>${lamp}`
    ]:provider==='claude'?[
      `<path fill="#d69766" d="M32 67h34v4H32zM62 51h3v18h-3z"/><path stroke="#735445" stroke-width="3" d="M58 51h10"/>${wheel(34,73,4)}${wheel(65,73,4)}`,
      `<path fill="#d48f69" d="M22 48h43l12 12v11H21V52z"/><path fill="#f1d2a3" d="M24 48h39v7H24zM23 63h51v5H23z"/><path fill="#8dbbbd" d="M62 52h4l8 9H62z"/><path fill="#795d4b" d="M26 55h10v12H26z"/>${wheel(32,71)}${wheel(65,71)}${lamp}`,
      `<path class="ride-jet" fill="#f3d9a4" d="M25 60L13 63l12 3z"/><path fill="#d19b69" d="M24 57h48l-9 14H35z"/><path fill="#f2d4a0" d="M30 57h37v5H30z"/><path stroke="#866f54" stroke-width="2" d="M63 56V43h9v17"/><ellipse fill="#e8bd83" cx="73" cy="43" rx="15" ry="9"/><path fill="none" stroke="#be8a5a" d="M61 43h24M73 35v16"/><g class="ride-propeller"><path stroke="#705947" stroke-width="3" d="M80 54v16M75 62h10"/></g><path class="ride-boost" fill="#ffe7a4" d="M25 59L5 63l20 3z"/>`
    ]:[
      `<path fill="#8266ac" d="M28 66h40l-5 6H33z"/><path fill="#beade4" d="M31 65h34v3H31z"/><path class="ride-jet" fill="#9fe5eb" d="M33 73h29l-5 3H38z"/>`,
      `${jet}<path fill="#8870b3" d="M26 54h39l13 10-10 7H26l-5-8z"/><path fill="#c6b4e9" d="M29 53h31l8 7H26z"/><path fill="#c3f0ed" d="M65 59l8 5h-8z"/><path fill="#574776" d="M33 69h26v4H33z"/>${lamp}`,
      `${jet}<path fill="#aa8acb" d="M26 51h36l21 12-21 9H26l6-10z"/><path fill="#e3d1ef" d="M64 53l19 10-19 7z"/><path fill="#70568f" d="M31 52l-7-8h14l9 9zM35 68l-9 9h17l9-9z"/><path fill="#b2eef0" d="M39 54h19v7H39z"/>`
    ];
    return body.map((svg,i)=>`<g class="ride-body ride-tier-${i+1}">${svg}<circle class="ride-warning" cx="77" cy="49" r="3" fill="#efb54d"/></g>`).join('');
  }
  const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  function characterHead(provider){
    // Repo-owned pixel silhouettes face the same direction; no session HTML is used.
    const robot=provider==='codex',pilot=provider==='antigravity';
    const head=robot?`<path fill="#314b58" d="M36 26h26v24H36zM32 32h4v10h-4z"/><path fill="#6c919b" d="M38 26h22v3H38z"/><path fill="#152c38" d="M46 32h18v12H46z"/><path class="ws-eyes" fill="#8ff5d7" d="M50 35h3v4h-3zM59 35h3v4h-3z"/><path fill="#8ff5d7" d="M43 53l4 3-4 3v-2l2-1-2-1zM49 58h5v2h-5z"/>`:
      pilot?`<path fill="#a68bd7" d="M38 24h20v4h5v5h3v13h-6v4H36v-6h-4V32h6z"/><path fill="#dfd5f5" d="M39 27h18v3H39z"/><path fill="#283653" d="M45 32h17v3h3v10H43V35h2z"/><path class="ws-eyes" fill="#a6f2ef" d="M49 36h3v3h-3zM59 36h3v3h-3z"/>`:
      `<path fill="#c77351" d="M42 22h5v5h5v-4h4v6h5v-3h4v8h-5v4h7v5h-7v4h4v5h-8v-5h-5v5h-5v-5h-5v3h-5v-7h-5v-5h5v-4h-4v-5h8z"/><path fill="#e9a17b" d="M41 29h16v4h5v11h-5v3H41v-4h-4V33h4z"/><path class="ws-eyes" fill="#573a32" d="M49 35h2v3h-2zM58 35h2v3h-2z"/>`;
    return head;
  }
  function faceIcon(provider,status){
    const expressions={
      running:'M49 35h4v4h-4zM58 35h4v4h-4zM48 32h6v1h-6zM57 32h6v1h-6z',
      background:'M49 36h4v2h-4zM58 36h4v2h-4z',
      waiting_input:'M49 34h4v6h-4zM58 34h4v6h-4zM49 31h4v1h-4zM58 31h4v1h-4z',
      failed:'M48 33l6 3v2l-6-3zM57 36l6-3v2l-6 3zM51 42h8v2h-8z',
      unknown:'M49 35h4v2h-4zM58 37h4v2h-4zM58 32h4v1h-4z',
      completed:'M48 37h2v-2h3v2h2v2h-2v-2h-3v2h-2zM57 37h2v-2h3v2h2v2h-2v-2h-3v2h-2z'
    };
    let head=characterHead(provider);
    if(expressions[status])head=head.replace(/<path class="ws-eyes"[^>]*\/>/,`<path fill="${provider==='claude'?'#573a32':provider==='codex'?'#8ff5d7':'#a6f2ef'}" d="${expressions[status]}"/>`);
    const mark=status==='waiting_input'?'<circle cx="64" cy="25" r="4" fill="#db921c" stroke="#fff3cf" stroke-width="1.5"/>':status==='failed'?'<path d="M64 20l5 5-5 5-5-5z" fill="#c94b49" stroke="#ffe4dc"/>':status==='unknown'?'<circle cx="64" cy="25" r="4" fill="#778392" stroke="#edf1f6" stroke-width="1.5"/>':'';
    return `<svg viewBox="29 20 40 34" aria-hidden="true" focusable="false" shape-rendering="crispEdges">${head}<ellipse class="orbit-face-ring" cx="49" cy="37" rx="18" ry="16" fill="none" stroke="#a6a2e7" stroke-width="1.4"/>${mark}</svg>`;
  }
  function character(provider){
    const head=characterHead(provider);
    return `<ellipse class="ws-shadow" cx="49" cy="75" rx="16" ry="2"/>
      <g class="ws-person">
        <g class="ws-backpack"><path d="M29 46h10v19H27V50h2z"/><path fill="#e7cfa1" d="M29 51h6v2h-6zM29 57h6v2h-6z"/></g>
        <path class="ws-thruster" d="M28 59L13 67l17-3z"/>
        <g class="ws-leg ws-leg-back"><path d="M40 61h7v10h4v3H40z"/></g>
        <g class="ws-leg ws-leg-front"><path d="M51 61h7v10h5v3H51z"/></g>
        <path class="ws-body" d="M37 47h22v17H37z"/>
        ${head}
        <path class="ws-closed-eyes" d="M49 39h4v1h-4zM58 39h4v1h-4z"/>
        <g class="ws-arm"><path class="ws-body" d="M48 49h7v10h7v5H48z"/><path class="ws-hand" d="M59 59h5v5h-5z"/></g>
        <g class="ws-rainwear"><path class="ws-rain-coat" d="M35 47h25l4 19H33z"/><path class="ws-pack-cover" d="M27 47h10v17H26V50z"/></g>
        <g class="ws-scarf"><path fill="#edb65e" d="M36 46h25v4H36zM38 50h5v11h-5z"/></g>
        <g class="ws-earmuffs" fill="#f4d2a4"><path d="M34 32h5v10h-5zM60 32h5v10h-5z"/></g>
        <g class="ws-rain-hat"><path d="M35 27h28v4H32v-2h3zM39 24h20v3H39z"/></g>
        <path class="ws-rain-shield" fill="#c9f3f3" fill-opacity=".12" stroke="#9ddbdc" d="M32 46V31l7-8h18l9 8v15"/>
        <g class="ws-blanket"><path fill="#aebacf" d="M34 52h27l3 15H32z"/><path fill="#dbe1ec" d="M35 54h25v2H35zM36 60h25v2H36z"/></g>
        <g class="ws-lantern"><ellipse class="ws-lantern-glow" cx="69" cy="62" rx="13" ry="12" fill="#f8d37b" opacity=".18"/><path fill="none" stroke="#8b7751" d="M66 57v-4h6v4"/><path fill="#725d41" d="M64 57h10v12H64z"/><path fill="#ffdc87" d="M66 59h6v7h-6z"/></g>
        <g class="ws-map"><path fill="#e7d9ae" d="M57 48l6-2 6 3 5-2v13l-5 2-6-3-6 2z"/><path fill="none" stroke="#8b9c78" d="M60 54l5 2 5-4"/></g>
      </g>`;
  }
  // Theme-only SVG reuses the provider identity; all telemetry remains in render().
  function orbitCraft(provider){
    return `<g class="orbit-craft" shape-rendering="geometricPrecision">
      <ellipse class="orbit-landing" cx="49" cy="74" rx="30" ry="3" fill="none" stroke="currentColor" opacity=".3"/>
      <g class="orbit-engine"><path d="M24 55Q1 56 2 61Q9 68 26 66Z" fill="currentColor" opacity=".35"/><path d="M25 58L6 61 25 64Z" fill="#ffe5ff"/></g>
      <path d="M26 53C22 31 30 14 48 14C69 14 78 35 74 55Z" fill="#19334c" fill-opacity=".75" stroke="#9bb5d8" stroke-width="1.5"/>
      <path d="M30 34Q31 18 48 18" fill="none" stroke="#e1f4ff" stroke-width="2" opacity=".6"/>
      <path d="M35 49Q49 43 61 49L65 58H32Z" fill="currentColor" opacity=".8"/>
      <g class="orbit-pilot" transform="translate(3 2) scale(.94)">${characterHead(provider)}<path class="ws-closed-eyes" d="M49 39h4m5 0h4" fill="none" stroke="currentColor" stroke-width="1.5"/></g>
      <path d="M25 52Q50 58 74 50L88 59Q78 71 53 72H29L20 63Z" fill="#9daccd" stroke="#dce7ff" stroke-width="1"/>
      <path d="M23 61Q51 68 85 59L76 68 51 74H28Z" fill="#29324f"/>
      <path d="M35 65L49 62 65 66 55 76H33Z" fill="#5d6586" stroke="#a9b7d1" stroke-width=".7"/>
      <path d="M69 56L80 58 74 62H66Z" fill="currentColor"/>
      <path d="M27 58H40M46 59H51" fill="none" stroke="currentColor" stroke-width="2"/>
      <path d="M34 21Q55 8 69 31L73 48" fill="none" stroke="currentColor" opacity=".6"/>
      <g class="orbit-droplets" fill="#b8deff" opacity=".65"><ellipse cx="32" cy="32" rx=".8" ry="2"/><ellipse cx="66" cy="37" rx=".8" ry="2.4"/><ellipse cx="55" cy="19" rx="1" ry="1.6"/><path d="M71 29l-1 4M28 43l-1 4" stroke="#b8deff"/></g>
      <path class="orbit-frost" d="M28 49L30 41 33 47 35 39M63 21l2 5 4-1M66 48l4-6 2 6" fill="none" stroke="#d4faff" stroke-width="2"/>
      <g class="orbit-signal" fill="none" stroke="#62f2de" stroke-width="1.5"><circle cx="79" cy="25" r="2" fill="#62f2de"/><path d="M75 21a6 6 0 0 0 0 8M83 21a6 6 0 0 1 0 8M72 18a10 10 0 0 0 0 14M86 18a10 10 0 0 1 0 14"/></g>
      <g class="orbit-warning"><path d="M79 18L88 33H70Z" fill="#ffbd7c"/><path d="M79 23v4m0 2v1" stroke="#432b30" stroke-width="2"/></g>
    </g>`;
  }
  function scene(provider){
    return `<svg viewBox="0 0 96 80" aria-hidden="true" focusable="false" shape-rendering="crispEdges">
      ${orbitCraft(provider)}<g class="ws-finished-items"></g><g class="ride-rig">${character(provider)}<g class="ride-vehicle">${vehicle(provider)}</g></g>
      <g class="ws-dust"><path d="M22 70h4v2h-4zM29 73h3v2h-3zM17 74h3v2h-3z"/></g>
      <g class="ws-sleep"><text x="65" y="29">z</text><text x="75" y="21">z</text></g>
      <g class="ws-bubble"><path fill="#efd286" d="M68 22h16v14H74l-4 4v-4h-2z"/><path fill="#614c30" d="M75 25h2v5h-2zM75 32h2v2h-2z"/></g>
      <ellipse class="ws-arrival" cx="49" cy="74" rx="16" ry="3"/>
    </svg>`;
  }
  function cloudLayer(depth,shapes){
    const outlines=[
      'M3 26C0 20 8 16 17 17C17 8 26 4 36 8C43-2 61 2 65 13C76 9 85 15 85 21C99 20 104 29 94 31C73 35 15 34 3 26Z',
      'M2 27C2 21 11 19 23 20C28 11 41 10 48 17C53 4 72 5 76 19C88 16 101 22 98 28C86 33 18 34 2 27Z',
      'M4 26C-2 20 9 14 21 16C23 3 42 0 50 12C61 7 72 12 73 20C85 17 100 22 98 27C89 33 16 35 4 26Z'
    ];
    return `<div class="journey-clouds journey-clouds-${depth}">${shapes.map(i=>`<div class="journey-cloud"><svg viewBox="0 0 100 36" preserveAspectRatio="none" focusable="false"><path d="${outlines[i]}"/></svg></div>`).join('')}</div>`;
  }
  function cargo(button,kind,count,mark=''){
    const signature=[kind,count,mark].join(':');if(button.dataset.cargo===signature)return;
    button.dataset.cargo=signature;button.dataset.count=count===null?'unknown':String(count);
    button.classList.add('journey-cargo');button.dataset.kind=kind;
    const stack=el('span','cargo-stack');stack.setAttribute('aria-hidden','true');
    for(let i=0;i<Math.min(3,count??0);i++){
      const item=el('span','cargo-item');
      item.innerHTML=kind==='done'?'<svg viewBox="0 0 24 26" focusable="false"><path class="cargo-flag" d="M15 10V1h7l-2 3 2 3h-7"/><path class="cargo-body" d="M2 10h20v14H2z"/><path class="cargo-ribbon" d="M10 10h4v14h-4zM2 15h20"/></svg>':'<svg viewBox="0 0 24 26" focusable="false"><path class="cargo-handle" d="M8 9V5h8v4"/><rect class="cargo-body" x="2" y="9" width="20" height="15" rx="3"/><path class="cargo-strap" d="M7 10v13m10-13v13"/></svg>';
      stack.append(item);
    }
    const more=el('span','cargo-more',count>3?'+':'');more.hidden=!(count>3);stack.append(more);
    const state=el('span','cargo-state',mark);state.hidden=!mark;stack.append(state);
    button.replaceChildren(stack);
  }
  function create(container,onOpen,onUsage=()=>{},orderUsage=row=>row.windows,onSelect=null){
    const nodes=new Map();let current=null,currentNow=null,wasStale=false,sharedTimer=null;
    const recentArrivals=new Map();
    // One clock drives only moving rooms; positions survive pauses and speed changes.
    const sceneryMotion=matchMedia('(prefers-reduced-motion: reduce)');
    let sceneryFrame=null,sceneryLast=null;
    function scheduleScenery(){
      if(sceneryFrame===null&&!document.hidden&&!sceneryMotion.matches&&[...nodes.values()].some(n=>n.scenery&&(n.scenery.target||n.scenery.speed)))sceneryFrame=requestAnimationFrame(tickScenery);
    }
    function tickScenery(now){
      sceneryFrame=null;
      if(document.hidden||sceneryMotion.matches)return;
      const dt=sceneryLast===null?0:Math.min(64,now-sceneryLast)/1000;sceneryLast=now;
      for(const n of nodes.values()){
        const s=n.scenery;if(!s)continue;
        const fraction=Math.min(1,Math.max(0,(now-s.started)/600)),blend=fraction*fraction*(3-2*fraction);
        s.speed=s.from+(s.target-s.from)*blend;
        s.roadX=(s.roadX+s.speed*dt)%180;s.hillX=(s.hillX+s.speed*.22*dt)%240;s.mountainX=(s.mountainX+s.speed*.06*dt)%320;
        s.road.style.transform=`translateX(${-s.roadX}px)`;s.hill.style.transform=`translateX(${-s.hillX}px)`;s.mountain.style.transform=`translateX(${-s.mountainX}px)`;
      }
      if([...nodes.values()].some(n=>n.scenery&&(n.scenery.target||n.scenery.speed)))scheduleScenery();else sceneryLast=null;
    }
    function sceneryTarget(s,target,immediate=false){
      if(!s)return;
      if(immediate){s.target=target;s.speed=target;s.from=target;s.started=performance.now();}
      else if(s.target!==target){s.from=s.speed;s.target=target;s.started=performance.now();}
    }
    function pauseScenery(){
      if(sceneryFrame!==null)cancelAnimationFrame(sceneryFrame);sceneryFrame=null;sceneryLast=null;
      for(const n of nodes.values())if(n.scenery){n.scenery.speed=0;n.scenery.from=0;n.scenery.started=performance.now();}
    }
    function sceneryVisibility(){pauseScenery();scheduleScenery();}
    sceneryMotion.addEventListener('change',sceneryVisibility);
    document.addEventListener('visibilitychange',sceneryVisibility);
    function makeScenery(room){
      const hill=room.querySelector('.journey-hills');if(!hill)return null;
      hill.classList.add('journey-parallax-hills');
      const tile='<svg viewBox="0 0 240 100" preserveAspectRatio="none" focusable="false"><path d="M0 65C30 65 32 35 65 35S110 75 145 75S200 65 240 65V100H0Z"/></svg>';
      hill.innerHTML=tile+tile;
      const mountain=room.querySelector('.journey-mountains');mountain.classList.add('journey-parallax-mountains');
      const mountainTile='<svg viewBox="0 0 320 100" preserveAspectRatio="none" focusable="false"><path d="M0 58C16 58 20 50 31 35S48 9 61 28S79 68 98 51S123 22 137 35S157 63 174 40S192 2 209 20S234 59 253 45S279 58 296 58S312 58 320 58V100H0Z"/></svg>';
      mountain.innerHTML=mountainTile+mountainTile;
      const road=el('div','journey-trail');
      const marks='<path class="trail-grass" d="M12 10v-4h2v4h3v2h-7v-2zM96 4v-3h2v3h3v2h-7V4zM154 13v-4h2v4h3v2h-7v-2z"/><path class="trail-stones" d="M42 13h5v2h-5zM73 7h3v2h-3zM129 6h6v2h-6zM172 11h3v2h-3z"/>';
      road.innerHTML=`<svg viewBox="0 0 360 18" focusable="false" preserveAspectRatio="none"><g>${marks}</g><g transform="translate(180 0)">${marks}</g></svg>`;
      room.querySelector('.journey-road').append(road);
      return {hill,road,mountain,roadX:0,hillX:0,mountainX:0,speed:0,target:0,from:0,started:performance.now()};
    }

    const landscape=el('div','journey-landscape');landscape.setAttribute('aria-hidden','true');
    landscape.innerHTML=`<div class="journey-stars"></div><div class="journey-orb"></div>
      ${cloudLayer('far',[1,0,2])}${cloudLayer('near',[0,2,1,2])}
      <div class="journey-mountains"><svg viewBox="0 0 1000 100" preserveAspectRatio="none" focusable="false"><path d="M0 75C34 70 61 53 89 49S119 23 144 29S181 62 207 58S246 42 267 47S301 36 324 17S359 12 380 30S416 64 449 61S496 80 531 60S575 46 606 49S648 28 672 34S701 58 725 51S757 13 784 8S816 36 842 37S880 55 906 45S956 58 1000 34V100H0Z"/></svg></div>
      <div class="journey-hills"><svg viewBox="0 0 1000 100" preserveAspectRatio="none" focusable="false"><path d="M0 63C62 34 97 51 143 67S215 61 261 32S338 20 395 48S480 83 543 62S633 10 696 24S775 61 828 41S925 51 1000 16V100H0Z"/></svg></div>
      <div class="journey-road"></div><div class="journey-shared-light"></div><div class="journey-puddles"></div><div class="journey-fog"></div><div class="journey-precipitation"></div>`;
    container.append(landscape);
    for(const provider of providers){
      const room=el('article','workshop-room');room.dataset.workshopProvider=provider;room.dataset.pose='loading';
      const heading=el('button','workshop-name',names[provider]);heading.type='button';heading.onclick=()=>onSelect?onSelect(provider):onOpen(provider,'all');
      const stage=el('button','workshop-scene');stage.type='button';stage.setAttribute('aria-label',names[provider]+' 작업 일지 열기');stage.innerHTML=scene(provider);stage.onclick=()=>onSelect?onSelect(provider):onOpen(provider,'all');
      if(onSelect){heading.setAttribute('aria-hidden','true');heading.tabIndex=-1;stage.setAttribute('aria-pressed','false');}
      const cue=el('span','workshop-cue');cue.setAttribute('aria-hidden','true');stage.append(cue);
      const overlay=el('div','journey-overlay');
      const hp=el('button','journey-hp');hp.type='button';hp.setAttribute('aria-haspopup','dialog');hp.onclick=()=>onUsage(provider);
      const track=el('span','journey-hp-track'),fill=el('span','journey-hp-fill'),hpText=el('span','journey-hp-text','—');track.append(fill);hp.append(track,hpText);
      const badge=el('button','journey-task-badge');badge.type='button';
      badge.onclick=()=>onOpen(provider,badge.dataset.mode||'all');overlay.append(heading,hp);
      const arrival=el('button','journey-done-badge');arrival.type='button';arrival.setAttribute('aria-haspopup','dialog');arrival.onclick=()=>onOpen(provider,'completed');
      const traveller=el('div','journey-traveller');
      if(onSelect)room.append(landscape.cloneNode(true));
      traveller.append(stage,overlay,badge,arrival);
      const status=el('div','workshop-status');
      const note=el('span','workshop-note','상태 확인 중');
      const attention=el('button','workshop-attention');attention.type='button';attention.hidden=true;attention.onclick=()=>onOpen(provider,'attention');status.append(note,attention);
      const history=el('button','workshop-attention workshop-history');history.type='button';history.hidden=true;history.onclick=()=>onOpen(provider,'historical');status.append(history);
      const visual={};
      for(const kind of ['finished']){
        const group=stage.querySelector(`.ws-${kind}-items`),slots=[];
        for(let i=0;i<5;i++){
          const item=document.createElementNS('http://www.w3.org/2000/svg','g');
          item.setAttribute('class',`ws-count-item ws-${kind}-item`);item.setAttribute('transform',`translate(${3+i*7} ${72+(i%2)*3})`);
          item.innerHTML='<path class="ws-footlight" d="M2 0l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>';
          group.append(item);slots.push(item);
        }
        const more=document.createElementNS('http://www.w3.org/2000/svg','text');more.setAttribute('class','ws-count-overflow');more.setAttribute('x','6');more.setAttribute('y','66');group.append(more);
        visual[kind]={slots,more};
      }
      const recent=el('div','workshop-recent'),list=el('ul','workshop-recent-list');
      list.setAttribute('aria-label',names[provider]+' 최근 30분 완료 작업');
      const slots=Array.from({length:3},()=>{
        const row=el('li','workshop-recent-row'),title=el('span','workshop-recent-title'),time=el('time','workshop-recent-time');
        const main=el('span','workshop-recent-main'),folder=el('span','workshop-folder');
        main.append(folder,title);row.append(main,time);row.hidden=true;list.append(row);return {row,title,time,folder};
      });
      const empty=el('p','workshop-recent-empty','완료 상태 확인 중');
      const more=el('button','workshop-recent-more');more.type='button';more.hidden=true;more.setAttribute('aria-haspopup','dialog');more.onclick=()=>onOpen(provider,'completed');
      recent.append(list,empty,more);
      room.append(traveller,recent,status);
      if(onSelect){const quota=el('div','integrated-usage');quota.dataset.quotaProvider=provider;room.append(quota);}
      container.append(room);
      nodes.set(provider,{slots,empty,more,status,room,stage,note,attention,visual,cue,hp,fill,hpText,badge,arrival,history,vehicle:null,timer:null,scenery:onSelect?makeScenery(room):null});
    }
    function updateVehicleTitle(n){
        const orbit=document.documentElement.dataset.theme==='orbit';
        n.stage.title=orbit?'네온 오비트 · '+({working:'비행 중',background:'자동 운항',waiting:'통신 대기',failed:'점검 필요',sleeping:'정박 중',unknown:'상태 확인 중',loading:'상태 확인 중'}[n.room.dataset.pose]||'상태 확인 중'):vehicleNames[n.room.dataset.workshopProvider][(n.vehicle?.tier||1)-1]+(n.room.dataset.riding==='true'?' · 이동 중':' · 정차 중');
    }
    document.addEventListener('themechange',()=>{for(const n of nodes.values())updateVehicleTitle(n);});
    function render(state,now,stale=false,usageOffline=false){
      const next=model(state,now);
      // Freeze the last observation while offline; never let an idle pose imply certainty.
      const shown=stale?(current||model(null,null)):next;if(!stale){current=next;currentNow=now;}
      for(const r of shown.rooms){
        const n=nodes.get(r.provider);n.room.dataset.pose=stale?'unknown':r.pose;n.room.classList.toggle('is-stale',stale);
        n.room.dataset.gait=stale||!shown.ready||['unknown','loading','failed','waiting'].includes(r.pose)?'still':r.active>=4?'run':r.active>=2?'jog':r.active===1?'walk':'rest';
        const moving=['walk','jog','run'].includes(n.room.dataset.gait);
        const scenerySpeed=!moving?0:r.active===r.background?4:r.active>=4?22:r.active>=2?14:8;
        sceneryTarget(n.scenery,scenerySpeed,stale||!shown.ready||n.room.dataset.gait==='still');
        n.vehicle=vehicleState(n.vehicle,r.active,moving,now);
        n.room.dataset.vehicle=String(n.vehicle.tier);
        n.room.dataset.riding=String(moving);
        updateVehicleTitle(n);
        const usage=state?.usage?.find(u=>u.provider===r.provider);
        const q=quota(usage?{...usage,windows:orderUsage(usage)}:null,now,usageOffline);
        n.hp.classList.toggle('is-unknown',q.percent===null);
        n.fill.style.width=(q.percent??0)+'%';
        const fmt=v=>new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(v);
        const excess=q.overagePercent??(q.used-q.recommended);
        const overage=`+${excess>0&&excess<0.1?'<0.1':fmt(excess)}${q.overagePercent===null?'%p':'%'} 초과`;
        n.hp.classList.toggle('is-exceeded',q.percent!==null&&q.exceeded);
        n.hpText.textContent=q.percent===null?'확인 중':(q.exceeded?overage:Math.round(q.percent)+'%')+(q.partial?'*':'');
        n.hp.title=q.percent===null?'일일 권장량 확인 불가 · 사용량 상세':`오늘 사용 ${fmt(q.used)} / 권장 ${fmt(q.recommended)}%p · ${q.exceeded?`권장 대비 ${overage} · 실제 초과 ${fmt(q.used-q.recommended)}%p`:`남은 권장량 ${fmt(Math.max(0,q.recommended-q.used))}%p`}${q.partial?' · 일부 집계':''} · 실제 서비스 한도와 다름`;
        n.hp.setAttribute('aria-label',names[r.provider]+' '+n.hp.title);
        const uncertain=stale||!shown.ready||(r.active===0&&r.unknown>0);
        n.history.hidden=!r.historical;n.history.textContent=`지난 미확인 ${r.historical}`;
        const attention=r.waiting+r.failed;
        n.badge.hidden=false;
        cargo(n.badge,'active',shown.ready?r.active:null,uncertain?'?':attention?'!':'');
        n.badge.classList.toggle('has-dot',!uncertain&&r.active>0&&(attention>0||r.unknown>0));
        n.badge.dataset.mode=uncertain?'all':r.active>0||!attention?'running':'attention';
        n.badge.title=uncertain?'상태 확인 불가 · 작업 일지 열기':r.active>0?`진행 중 ${r.active}개 · 작업 목록 열기`:attention?`확인 필요 ${attention}개 · 작업 목록 열기`:'진행 중 0개 · 작업 목록 열기';
        n.badge.setAttribute('aria-label',names[r.provider]+(uncertain?' 상태 확인 불가':r.active>0?` 진행 ${r.active}개${attention?' · 확인 필요 '+attention+'개':''}${r.unknown?' · 상태 미확인 '+r.unknown+'개':''}`:attention?` 확인 필요 ${attention}개`:' 진행 0개'));
        const completionTitle='최근 30분 내 완료된 현재 완료 상태의 작업 · 도구별 세션당 1개';
        cargo(n.arrival,'done',shown.ready?r.done:null,stale||!shown.ready?'?':shown.partial?'*':'');
        n.arrival.title=(shown.ready&&r.done!==null?`완료 ${r.done}개 · `:'확인 불가 · ')+completionTitle+(stale?' · 이전 값':shown.partial?' · 완료 시각 미확인 작업 제외':'')+' · 작업 목록 열기';
        n.arrival.setAttribute('aria-label',names[r.provider]+' 최근 30분 완료 작업 '+(shown.ready&&r.done!==null?r.done+'개':'확인 불가')+(stale?' · 이전 값':shown.partial?' · 일부 집계':'')+' · 목록 열기');
        n.arrival.classList.toggle('is-stale',stale);
        const tasks=(shown.entries||[]).filter(e=>e.provider===r.provider).sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id));
        n.slots.forEach((slot,i)=>{
          const task=tasks[i];slot.row.hidden=!task;if(!task)return;
          const title=task.title?.trim()||'이름 없는 작업';
          slot.title.textContent=title;slot.title.title=title;
          const path=typeof task.cwd==='string'?task.cwd.trim():'';
          const folder=path.split(/[\\/]+/).filter(Boolean).pop()||'';
          slot.folder.hidden=!folder;slot.folder.textContent=folder;slot.folder.title=path;
          slot.folder.setAttribute('aria-label','작업 폴더: '+path);
          const seconds=Math.max(0,Math.floor((stale?(currentNow??now):now)-task.at));
          const remaining=Math.max(0,1800-seconds);
          const duration=s=>s<60?`${s}초`:`${Math.floor(s/60)}분${s%60?' '+s%60+'초':''}`;
          const date=new Date(task.at*1000);
          const description=stale?'이전 관측값 · 연결 또는 수집 상태 확인 중':`${duration(seconds)} 전 완료 · ${duration(remaining)} 후 목록에서 숨김`;
          slot.time.textContent='';slot.time.dateTime=date.toISOString();
          slot.time.style.setProperty('--elapsed-angle',Math.min(360,seconds/1800*360)+'deg');
          slot.time.setAttribute('role','img');
          slot.time.setAttribute('aria-label',description+' · '+date.toLocaleString('ko-KR'));
          slot.time.title=slot.time.getAttribute('aria-label');

        });
        n.empty.hidden=tasks.length>0;
        n.empty.textContent=!shown.ready||shown.entries===null?'완료 상태 확인 중':stale?'완료 상태 확인 불가':'최근 30분 완료 없음';
        n.more.hidden=tasks.length<=3;n.more.textContent=`+${Math.max(0,tasks.length-3)}개 더 보기`;
        n.more.setAttribute('aria-label',names[r.provider]+` 최근 완료 ${tasks.length}개 전체 보기`);
        n.note.textContent=stale?(shown.ready?'이전 값 · 상태 확인 불가':'상태 확인 불가'):!shown.ready?'상태 확인 중':r.unknown?`상태 확인 불가 ${r.unknown}`:r.background?`백그라운드 ${r.background} 포함`:({working:n.stage.title,waiting:'확인을 기다리는 중',failed:'작업 확인 필요',sleeping:'쉬는 중 · 관측된 진행 없음',unknown:'상태 확인 불가'})[r.pose]||'작업 중';
        n.note.hidden=!stale&&shown.ready&&!r.unknown&&!r.background;
        n.status.hidden=n.note.hidden&&!r.waiting&&!r.failed&&!r.historical;
        n.room.classList.toggle('has-attention',!!(r.waiting+r.failed));n.attention.hidden=!(r.waiting+r.failed);n.attention.textContent=`확인 필요 ${r.waiting+r.failed}`;
        for(const [kind,count] of [['finished',shown.ready?r.done:null]]){
          const v=n.visual[kind];v.slots.forEach((item,i)=>item.classList.toggle('is-filled',count!==null&&i<count));
          v.more.textContent=count>5?`+${count-5}`:'';
          // Keep the full exact value readable even when the illustrated row is capped.
          if(count>5)v.more.setAttribute('textLength','16');else v.more.removeAttribute('textLength');
          v.more.setAttribute('lengthAdjust','spacingAndGlyphs');
        }
        n.stage.setAttribute('aria-label',`${names[r.provider]} ${n.stage.title} · ${onSelect?'도구 필터 선택':'작업 일지 열기'} · 진행 ${shown.ready?r.active:'확인 중'} · 최근 30분 완료 ${shown.ready&&r.done!==null?r.done:'확인 불가'}${shown.partial?' · 일부 집계':''}${stale?' · 이전 값':''}`);
        n.stage.title=names[r.provider]+' · '+n.stage.title;
        if(stale){clearTimeout(n.timer);n.room.classList.remove('is-packing');n.cue.textContent='';}
      }
      container.classList.toggle('journey-moving',!stale&&shown.ready&&shown.rooms.some(r=>r.active>0));
      container.classList.toggle('journey-stale',stale);
      if(stale){recentArrivals.clear();clearTimeout(sharedTimer);container.classList.remove('journey-celebrating');}
      scheduleScenery();wasStale=stale;return shown;
    }
    function celebrate(events,now){
      if(wasStale||document.hidden||!Number.isFinite(now))return;
      for(const provider of providers){
        const count=new Set(events.filter(e=>e.provider===provider&&now>=e.at&&now-e.at<=5&&current?.entries?.some(r=>key(r)===key(e))).map(key)).size;if(!count)continue;
        recentArrivals.set(provider,now);
        const n=nodes.get(provider);clearTimeout(n.timer);n.room.classList.remove('is-packing');
        n.cue.textContent=`✓ +${count}`;
        if(!matchMedia('(prefers-reduced-motion: reduce)').matches)n.room.classList.add('is-packing');
        n.timer=setTimeout(()=>{n.room.classList.remove('is-packing');n.cue.textContent='';},matchMedia('(prefers-reduced-motion: reduce)').matches?3000:1200);
      }
      for(const [provider,at] of recentArrivals)if(now-at>3)recentArrivals.delete(provider);
      if(recentArrivals.size>1&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
        container.classList.add('journey-celebrating');clearTimeout(sharedTimer);
        sharedTimer=setTimeout(()=>container.classList.remove('journey-celebrating'),1200);recentArrivals.clear();
      }
    }
    function reset(){pauseScenery();for(const n of nodes.values())sceneryTarget(n.scenery,0,true);current=null;currentNow=null;recentArrivals.clear();clearTimeout(sharedTimer);container.classList.remove('journey-celebrating');for(const n of nodes.values()){n.vehicle=null;clearTimeout(n.timer);n.room.classList.remove('is-packing');n.cue.textContent='';}}
    document.addEventListener('visibilitychange',()=>{container.classList.toggle('workshop-paused',document.hidden);if(document.hidden){recentArrivals.clear();clearTimeout(sharedTimer);container.classList.remove('journey-celebrating');}if(document.hidden)for(const n of nodes.values()){clearTimeout(n.timer);n.cue.textContent='';n.room.classList.remove('is-packing');}});
    return {render,celebrate,reset};
  }
  const api={model,completed,quota,historicalUnknown,vehicleState,faceIcon,create};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.LocalMonitorWorkshop=api;
})(typeof window!=='undefined'?window:globalThis);
