'use strict';
(function(root){
  const names={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity'};
  const states={running:'진행 중',background:'백그라운드',waiting_input:'확인 필요',failed:'오류',unknown:'상태 미확인',completed:'완료'};
  const rank={waiting_input:0,failed:1,unknown:2,completed:3,running:4,background:5};
  const visibleTask=r=>!['running','background'].includes(r.status);
  const clean=s=>typeof s==='string'?s:'';
  const plain=s=>s.replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/^[#>]+\s*/gm,'').replace(/\*\*|__|`/g,'').trim();
  function readPreview(row){
    const p=row?.preview||{},text=clean(p.text).slice(0,8000);
    const questions=(Array.isArray(p.questions)?p.questions:[]).slice(0,3).filter(q=>q&&typeof q.question==='string').map(q=>({question:q.question.slice(0,1000),options:(Array.isArray(q.options)?q.options:[]).slice(0,6).filter(o=>o&&typeof o.label==='string').map(o=>({label:o.label.slice(0,200),description:clean(o.description).slice(0,500)}))}));
    // Only a named choices section is interpreted as choices; numbered result lists stay prose.
    const lines=text.split('\n'),start=lines.findIndex(l=>/^\s*(?:#{1,6}\s*)?(?:\*\*)?선택지(?:와 추천)?(?:\*\*)?\s*[:：]?\s*$/.test(l));
    const choices=[];
    if(start>=0)for(const l of lines.slice(start+1)){
      if(/^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:추천|목적|정합 상태)/.test(l))break;
      const match=l.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)/);if(match)choices.push(plain(match[1]));
    }
    const body=text.split(/\n\s*(?:#{1,6}\s*)?(?:\*\*)?(?:정합 상태\s*[·:：]|선택지(?:와 추천)?(?:\*\*)?\s*\n)/)[0];
    const fallback=row?.status==='unknown'?'현재 상태를 확인할 수 없어요. 작업 일지에서 확인해 주세요.':'메시지를 가져올 수 없어요. 원래 대화에서 확인해 주세요.';
    const candidate=row?.preview_summary,aiLines=!!(text||questions.length)&&['completed','waiting_input'].includes(row?.status)&&candidate?.model==='gpt-6-luna'&&Array.isArray(candidate.lines)&&candidate.lines.length===2&&candidate.lines.every(s=>typeof s==='string'&&s.trim()===s&&s.length>0&&Array.from(s).length<=40&&!/[\x00-\x1f\x7f-\x9f]/.test(s))?candidate.lines:null;
    const rawSummary=questions.length?questions.map(q=>q.question).join(' · '):plain(body)||fallback;
    const pending=!!(text||questions.length)&&['completed','waiting_input'].includes(row?.status)&&!aiLines&&!(candidate?.model==='gpt-6-luna'&&candidate.status==='failed');
    return {aiLines,pending,rawSummary,text,questions,truncated:p.truncated===true,summary:aiLines?aiLines.join('\n'):pending?'확인 중':rawSummary,
      choices:questions.length?questions.flatMap(q=>q.options.map(o=>o.label)):choices,available:!!(text||questions.length)};
  }

  const identity=r=>JSON.stringify([r.provider,r.session_id]);
  const workshop=()=>typeof module!=='undefined'&&module.exports?require('./workshop.js'):root.LocalMonitorWorkshop;
  function groups(snapshot,now,{provider='all',mode='all',query=''}={}){
    const completed=new Set((workshop().completed(snapshot,now)||[]).map(identity));
    const unique=new Map((snapshot?.sessions||[]).map(r=>[identity(r),r]));
    const out=new Map(),search=query.trim().toLocaleLowerCase();
    for(const row of unique.values()){
      if(!names[row.provider]||!(row.status in states))continue;
      if(row.status==='completed'&&!completed.has(identity(row)))continue;
      if(workshop().historicalUnknown(row,now))continue;
      if(provider!=='all'&&row.provider!==provider)continue;
      if(mode==='running'&&!['running','background'].includes(row.status))continue;
      if(mode==='completed'&&row.status!=='completed')continue;
      const path=typeof row.cwd==='string'?row.cwd.trim():'';
      const name=path.split(/[\\/]+/).filter(Boolean).pop()||(path||'폴더 미확인');
      const title=row.title?.trim()||'이름 없는 작업';
      if(search&&![path,name,title,names[row.provider]].some(s=>s.toLocaleLowerCase().includes(search)))continue;
      if(!out.has(path))out.set(path,{path,name,rows:[],active:0,done:0,attention:0});
      const group=out.get(path);group.rows.push({provider:row.provider,session_id:row.session_id,title,status:row.status,completed_at:row.completed_at,preview:row.preview,preview_summary:row.preview_summary});
      if(['running','background'].includes(row.status))group.active++;
      else if(row.status==='completed')group.done++;else group.attention++;
    }
    for(const g of out.values())g.rows.sort((a,b)=>rank[a.status]-rank[b.status]||(b.completed_at||0)-(a.completed_at||0)||a.title.localeCompare(b.title)||identity(a).localeCompare(identity(b)));
    return [...out.values()].sort((a,b)=>Number(b.active>0)-Number(a.active>0)||a.name.localeCompare(b.name)||a.path.localeCompare(b.path));
  }
  // Keep path identity untouched; compare components instead of string prefixes.
  function pathParts(path){
    const value=path.replace(/\\/g,'/'),root=value.startsWith('//')?'//':value.startsWith('/')?'/':'';
    return [root,...value.split('/').filter(Boolean)];
  }
  function hierarchy(groups,closed=new Set()){
    const nodes=groups.map(group=>({...group,parts:pathParts(group.path),children:[],total:{active:group.active,done:group.done,attention:group.attention}}));
    const roots=[];
    for(const node of nodes){
      let parent=null;
      if(node.path)for(const candidate of nodes){
        if(!candidate.path||candidate.parts.length>=node.parts.length)continue;
        if(candidate.parts.every((part,i)=>part===node.parts[i])&&(!parent||candidate.parts.length>parent.parts.length))parent=candidate;
      }
      node.parentPath=parent?.path??null;
      node.label=parent?node.parts.slice(parent.parts.length).join('/'):node.name;
      (parent?parent.children:roots).push(node);
    }
    function aggregate(node){
      for(const child of node.children){aggregate(child);for(const key of ['active','done','attention'])node.total[key]+=child.total[key];}
    }
    roots.forEach(aggregate);
    const ordered=[],compare=(a,b)=>Number(b.total.active>0)-Number(a.total.active>0)||a.label.localeCompare(b.label)||a.path.localeCompare(b.path);
    function visit(siblings,depth){
      for(const node of siblings.sort(compare)){
        const {parts,children,...group}=node;
        ordered.push({...group,depth,hasChildren:children.length>0});
        if(!closed.has(node.path))visit(children,depth+1);
      }
    }
    visit(roots,0);return ordered;
  }
  function layout(groups,closed=new Set(),selected=new Map()){
    const siblings=new Map(),items=[];
    for(const group of hierarchy(groups)){
      // Aggregate first: hidden active-only descendants still count in their project.
      if(group.parentPath!==null&&!group.total.attention&&!group.total.done)continue;
      if(!siblings.has(group.parentPath))siblings.set(group.parentPath,[]);
      siblings.get(group.parentPath).push(group);
    }
    function visit(group){
      const open=group.parentPath!==null||!closed.has(group.path);
      const children=siblings.get(group.path)||[];
      items.push({...group,kind:'folder',open,hasChildren:children.length>0});
      if(!open||!children.length)return;
      const active=children.find(child=>child.path===selected.get(group.path));
      items.push({kind:'chips',path:group.path,depth:group.depth+1,children,selected:active?.path??null});
      if(active)visit(active);
    }
    for(const group of siblings.get(null)||[])visit(group);
    return items;
  }
  function create(container,onOpen,onSelect=()=>{}){
    const el=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;return node;};
    const controls={provider:'all',mode:'all',query:''},closed=new Set(),selected=new Map(),expandedChips=new Set();let snapshot=null,at=null,stale=false,signature='',pies=[],observed=null,arrivals=new Set();
    const head=el('div','folder-toolbar'),heading=el('h2','folder-heading','폴더별 작업');
    head.append(heading);
    const notice=el('p','folder-notice');notice.setAttribute('role','status');
    const list=el('div','folder-list');container.append(head,notice,list);
    const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)'),animations=new Set();
    let exitLayer=null,hasBaseline=false,motionScroll=0;
    list.tabIndex=-1;list.setAttribute('aria-label','폴더별 작업 목록');
    function cancelMotion(){
      for(const animation of animations)animation.cancel();animations.clear();
      exitLayer?.remove();exitLayer=null;list.classList.remove('is-transitioning');
    }
    const motionAllowed=()=>!stale&&!document.hidden&&!reducedMotion.matches&&typeof list.animate==='function';
    function measure(){
      const bounds=list.getBoundingClientRect(),items=new Map();
      for(const node of list.querySelectorAll('.folder-group,.folder-task,.folder-chip-row,.folder-chip,.folder-chip-more')){
        const rect=node.getBoundingClientRect();if(!rect.height)continue;
        const group=node.classList.contains('folder-group')||node.classList.contains('folder-chip-row');
        items.set(group?node.dataset.layoutKey:node.dataset.focusKey,{node,rect,group,
          parent:group?null:node.closest('.folder-chip-row,.folder-group').dataset.layoutKey,
          visible:rect.bottom>bounds.top&&rect.top<bounds.bottom});
      }
      return items;
    }
    // Exit copies are purely visual: no IDs, task keys, live regions or interactive targets.
    function exitCopy(source,retained){
      const copy=source.cloneNode(true),originals=[source,...source.querySelectorAll('*')],copies=[copy,...copy.querySelectorAll('*')];
      originals.forEach((node,i)=>{
        const clone=copies[i],style=getComputedStyle(node);
        for(const attr of [...clone.attributes])if(attr.name==='id'||attr.name==='class'||attr.name==='role'||attr.name==='tabindex'||attr.name.startsWith('data-')||attr.name.startsWith('aria-'))clone.removeAttribute(attr.name);
        for(const property of style)clone.style.setProperty(property,style.getPropertyValue(property));
        clone.style.setProperty('animation','none');clone.style.setProperty('transition','none');
        if(i&&retained.has(node.dataset.focusKey))clone.style.visibility='hidden';
      });
      copy.inert=true;copy.setAttribute('aria-hidden','true');return copy;
    }
    function play(node,frames,kind,done=()=>{}){
      list.classList.add('is-transitioning');
      const animation=node.animate(frames,{duration:400,easing:'cubic-bezier(.2,.7,.2,1)',fill:'both'});
      animation.id='folder-'+kind;animations.add(animation);
      animation.onfinish=()=>{animations.delete(animation);animation.cancel();done();if(!animations.size)list.classList.remove('is-transitioning');};
    }
    function restoreReadingPosition(before,scrollTop,focused){
      list.scrollTop=scrollTop;
      const current=new Map([...list.querySelectorAll('[data-focus-key]')].map(n=>[n.dataset.focusKey,n]));
      if(scrollTop>0){
        const candidates=[...before.values()].filter(v=>v.visible).sort((a,b)=>Number(a.group)-Number(b.group)||a.rect.top-b.rect.top);
        for(const item of candidates){
          const key=item.group?item.node.dataset.layoutKey:item.node.dataset.focusKey;
          const target=current.get(key),node=item.group?target?.closest('.folder-group,.folder-chip-row'):target;
          if(!node?.getBoundingClientRect().height)continue;
          list.scrollTop+=node.getBoundingClientRect().top-item.rect.top;break;
        }
      }
      if(focused){
        let target=current.get(focused)||current.get(focused.replace(/^folder:/,'chip:'))||current.get(focused.replace(/^chip:/,'folder:'));
        if(target?.hidden)target=target.closest('.folder-chip-row')?.querySelector('.folder-chip-more:not([hidden])');
        if(!target){
          const keys=[...before.keys()],index=keys.indexOf(focused);
          target=[...keys.slice(index+1),...keys.slice(0,index).reverse()].map(k=>current.get(k)).find(n=>n?.getBoundingClientRect().height);
        }
        (target||list).focus({preventScroll:true});
      }
    }
    function transition(before,after,exits){
      motionScroll=list.scrollTop;
      for(const [key,item] of after){
        const old=before.get(key),parent=item.parent&&after.get(item.parent);
        // A newly entering folder carries its children as one unit.
        if(parent&&!before.has(item.parent))continue;
        if(!item.visible&&!old?.visible)continue;
        if(!old){
          play(item.node,item.group?[{opacity:0,clipPath:'inset(0 0 100% 0)'},{opacity:1,clipPath:'inset(0 0 0% 0)'}]:[{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],'enter');
        }else{
          const oldParent=parent&&before.get(item.parent);
          const dx=old.rect.left-item.rect.left-(oldParent?oldParent.rect.left-parent.rect.left:0);
          const dy=old.rect.top-item.rect.top-(oldParent?oldParent.rect.top-parent.rect.top:0);
          if(Math.abs(dx)>.5||Math.abs(dy)>.5)play(item.node,[{transform:`translate(${dx}px,${dy}px)`},{transform:'translate(0,0)'}],'move');
        }
      }
      if(exits.length){
        const bounds=list.getBoundingClientRect();exitLayer=el('div','folder-exit-layer');exitLayer.inert=true;exitLayer.setAttribute('aria-hidden','true');
        exitLayer.style.top=list.scrollTop+'px';exitLayer.style.height=list.clientHeight+'px';list.append(exitLayer);
        const layer=exitLayer;
        for(const {copy,rect} of exits){
          Object.assign(copy.style,{position:'absolute',left:(rect.left-bounds.left)+'px',top:(rect.top-bounds.top)+'px',width:rect.width+'px',height:rect.height+'px',margin:'0',transform:'none',pointerEvents:'none'});
          layer.append(copy);
          play(copy,[{opacity:1,clipPath:'inset(0 0 0% 0)'},{opacity:0,clipPath:'inset(0 0 0% 0)',offset:.5},{opacity:0,clipPath:'inset(0 0 100% 0)'}],'exit',()=>{copy.remove();if(!layer.childElementCount){layer.remove();if(exitLayer===layer)exitLayer=null;}});
        }
      }
    }
    reducedMotion.addEventListener('change',cancelMotion);
    // User scrolling takes priority over a transient visual position.
    list.addEventListener('wheel',cancelMotion,{passive:true});list.addEventListener('touchstart',cancelMotion,{passive:true});
    list.addEventListener('pointerdown',cancelMotion);list.addEventListener('keydown',e=>{if(['PageUp','PageDown','Home','End','ArrowUp','ArrowDown'].includes(e.key))cancelMotion();});
    list.addEventListener('scroll',()=>{if(animations.size&&list.scrollTop!==motionScroll)cancelMotion();},{passive:true});
    function fitChipRows(){
      for(const row of list.querySelectorAll('.folder-chip-row')){
        const chips=[...row.querySelectorAll('.folder-chip')],more=row.querySelector('.folder-chip-more');
        const focused=row.contains(document.activeElement)?document.activeElement:null;
        const restoreFocus=()=>{
          if(!focused)return;
          const target=focused.hidden?(more.hidden?chips[0]:more):focused;
          if(target&&document.activeElement!==target)target.focus({preventScroll:true});
        };
        for(const chip of chips)chip.hidden=false;
        more.hidden=true;
        if(expandedChips.has(row.dataset.path)){
          more.textContent='접기';more.hidden=false;more.setAttribute('aria-expanded','true');more.setAttribute('aria-label',row.dataset.path+' 하위 폴더 목록 접기');restoreFocus();continue;
        }
        more.setAttribute('aria-expanded','false');
        if(!chips.length)continue;
        const lastTop=chips[0].offsetTop+chips[0].offsetHeight+4;
        if(chips.every(chip=>chip.offsetTop<=lastTop)){
          restoreFocus();
          continue;
        }
        more.hidden=false;
        for(let i=chips.length-1;i>=0;i--){
          chips[i].hidden=true;more.textContent='+'+(chips.length-i)+'개';
          if(more.offsetTop<=lastTop)break;
        }
        more.setAttribute('aria-label',row.dataset.path+' 하위 폴더 '+more.textContent+' 더보기');
        restoreFocus();
      }
    }
    window.addEventListener('resize',()=>{cancelMotion();fitChipRows();});
    new ResizeObserver(fitChipRows).observe(list);
    const visibility=()=>{container.classList.toggle('faces-paused',document.hidden);if(document.hidden)cancelMotion();};
    document.addEventListener('visibilitychange',visibility);visibility();
    function draw(allowMotion=true){
      container.classList.toggle('is-stale',stale);
      const ready=!!snapshot?.at;
      const grouped=ready?groups(snapshot,at,controls):[];
      const result=layout(grouped,closed,selected).map(g=>g.kind==='folder'?{...g,rows:g.rows.filter(visibleTask)}:g);
      const partial=(snapshot?.sessions||[]).some(r=>r.status==='completed'&&(!Number.isFinite(r.completed_at)||r.completed_at>at));
      notice.textContent=stale?'이전 관측값 · 연결 또는 수집 상태 확인 중':!ready?'첫 작업 상태를 기다리고 있어요.':partial?'일부 집계 · 완료 시각 미확인 작업 제외':controls.provider==='all'?'전체 도구 · 완료 작업은 최근 30분만 표시':names[controls.provider]+' 작업 · 전체 도구는 설정에서 선택';
      notice.hidden=ready&&!stale&&!partial&&controls.provider==='all';
      const next=JSON.stringify([result,ready,controls.provider,controls.mode,controls.query,[...expandedChips]]);
      if(next!==signature){
        const before=measure(),scrollTop=list.scrollTop;
        const focused=list.contains(document.activeElement)?document.activeElement.dataset.focusKey:null;
        const animate=allowMotion&&hasBaseline&&motionAllowed();
        const retained=new Set(result.flatMap(group=>group.kind==='chips'?['chips:'+group.path,'more:'+group.path,...group.children.map(child=>'chip:'+child.path)]:['folder:'+group.path,...(group.open?group.rows.map(task=>'task:'+identity(task)):[])]));
        const exits=[];
        if(animate)for(const [key,item] of before){
          if(retained.has(key)||!item.visible||(!item.group&&!retained.has(item.parent)))continue;
          exits.push({copy:exitCopy(item.node,retained),rect:item.rect});
        }
        cancelMotion();signature=next;pies=[];
        list.replaceChildren();
        if(!result.length)list.append(el('p','folder-empty',!ready?'작업 상태 확인 중':stale?'이전 관측에 표시할 작업이 없어요.':controls.query||controls.provider!=='all'||controls.mode!=='all'?'조건에 맞는 작업이 없어요.':'진행 중이거나 최근 완료된 작업이 없어요.'));
        for(const group of result){
          if(group.kind==='chips'){
            const rail=el('div','folder-chip-row');rail.dataset.path=group.path;rail.dataset.layoutKey='chips:'+group.path;rail.dataset.focusKey='chips:'+group.path;rail.tabIndex=-1;
            rail.setAttribute('role','group');rail.setAttribute('aria-label',group.path+' 하위 폴더');
            rail.style.setProperty('--folder-indent',Math.min(group.depth,3)*10+'px');
            for(const child of group.children){
              const chip=el('button','folder-chip');chip.type='button';chip.dataset.focusKey='chip:'+child.path;
              const open=group.selected===child.path,counts=child.total,count=counts.active+counts.done+counts.attention;
              chip.setAttribute('aria-expanded',String(open));
              if(open)chip.setAttribute('aria-controls','folder-panel-'+encodeURIComponent(child.path));
              chip.title=child.path+' · 진행 '+counts.active+' · 확인 '+counts.attention+' · 완료 '+counts.done;
              chip.setAttribute('aria-label',chip.title);chip.classList.toggle('selected',open);
              const arrow=el('span','folder-chip-arrow',open?'▾':'▸');arrow.setAttribute('aria-hidden','true');
              chip.append(arrow,el('span','folder-chip-name',child.label),el('span','folder-chip-count',String(count)));
              if(counts.attention){const dot=el('span','folder-chip-attention','●');dot.setAttribute('aria-hidden','true');chip.append(dot);}
              chip.onclick=()=>{cancelMotion();open?selected.delete(group.path):selected.set(group.path,child.path);draw(false);};
              rail.append(chip);
            }
            const more=el('button','folder-chip-more');more.type='button';more.dataset.focusKey='more:'+group.path;more.hidden=true;more.setAttribute('aria-label',group.path+' 하위 폴더 더보기 또는 접기');
            more.onclick=()=>{cancelMotion();expandedChips.has(group.path)?expandedChips.delete(group.path):expandedChips.add(group.path);draw(false);};
            rail.append(more);list.append(rail);continue;
          }
          const section=el('section','folder-group'),toggle=el('button','folder-toggle');section.dataset.layoutKey='folder:'+group.path;toggle.type='button';toggle.dataset.focusKey='folder:'+group.path;
          section.id='folder-panel-'+encodeURIComponent(group.path);section.classList.toggle('folder-detail',group.parentPath!==null);
          // Flat sections preserve independent movement/exit copies while preorder
          // and bounded indentation express the logical folder hierarchy.
          section.dataset.depth=group.depth;section.style.setProperty('--folder-indent',Math.min(group.depth,3)*10+'px');
          section.setAttribute('aria-label',group.path||'폴더 미확인');
          const label=el('span','folder-label'),icon=el('span','folder-icon','▰');icon.setAttribute('aria-hidden','true');
          const name=el('strong','folder-name',group.label),path=el('span','folder-path',group.path||'경로 정보 없음');path.title=group.path;name.title=group.path;
          const counts=group.total;
          const summary=el('span','folder-summary',[counts.active?'진행 '+counts.active:'',counts.attention?'확인 '+counts.attention:'',counts.done?'완료 '+counts.done:''].filter(Boolean).join(' · '));
          toggle.title=(group.path||'경로 정보 없음')+(group.hasChildren?' · 하위 폴더 포함':'');
          toggle.setAttribute('aria-label',(group.path||'폴더 미확인')+' · '+(group.depth+1)+'단계 · '+(group.hasChildren?'하위 폴더 포함 · ':'')+summary.textContent);
          const chevron=el('span','folder-chevron');chevron.setAttribute('aria-hidden','true');
          label.append(icon,name,path);toggle.append(label,summary,chevron);
          const rows=el('div','folder-rows');
          rows.hidden=!group.open;toggle.setAttribute('aria-expanded',String(group.open));chevron.textContent=group.parentPath!==null?'접기':group.open?'⌃':'⌄';
          toggle.onclick=()=>{cancelMotion();if(group.parentPath!==null)selected.delete(group.parentPath);else closed.has(group.path)?closed.delete(group.path):closed.add(group.path);draw(false);};
          for(const task of group.open?group.rows:[]){
            const row=el('button','folder-task');row.type='button';row.dataset.provider=task.provider;row.dataset.focusKey='task:'+identity(task);
            row.onclick=()=>onOpen(task.provider,task.status==='completed'?'completed':'all',task.session_id);
            const provider=el('span','folder-provider'),title=el('span','folder-task-title',task.title),status=el('span','folder-task-state',states[task.status]);
            provider.innerHTML=workshop().faceIcon(task.provider,task.status);
            // Stable per-session phase prevents synchronized rows and random redraw jumps.
            let phase=0;for(const char of identity(task))phase=(Math.imul(phase,31)+char.charCodeAt(0))>>>0;
            provider.style.setProperty('--face-phase',(-phase%2200/1000)+'s');
            provider.title=names[task.provider]+' · '+states[task.status];
            if(arrivals.delete(identity(task))&&!stale){provider.classList.add('face-arrival');provider.addEventListener('animationend',()=>provider.classList.remove('face-arrival'),{once:true});}provider.setAttribute('aria-hidden','true');
            row.title=names[task.provider]+' · '+task.title;
            row.dataset.status=task.status;title.title=task.title;row.setAttribute('aria-label',names[task.provider]+' · '+task.title+' · '+states[task.status]+' · 작업 일지 열기');
            row.append(provider,title,status);
            if(task.status!=='unknown'){
              const info=readPreview(task),message=el('span','folder-task-message',info.summary);
              if(info.aiLines){message.classList.add('is-ai-summary');message.textContent='';for(const line of info.aiLines)message.append(el('span','folder-summary-line',line));message.title='AI 요약 · GPT-6 Luna · 클릭하면 원문';}
              if(!info.available)message.classList.add('is-unavailable');
              row.append(message);
              if(info.choices.length&&!info.aiLines&&!info.pending){
                const choices=el('span','folder-task-choices','선택지 · '+info.choices.map((s,i)=>(i+1)+'. '+s).join('  /  '));
                row.append(choices);
              }
              row.setAttribute('aria-label',names[task.provider]+' · '+task.title+' · '+states[task.status]+' · '+info.summary+' · 메시지 상세 열기');
            }
            if(task.status==='completed'){const pie=el('time','workshop-recent-time folder-pie');pie.dateTime=new Date(task.completed_at*1000).toISOString();pie.setAttribute('role','img');row.insertBefore(pie,provider);pies.push({pie,row,time:task.completed_at});}
            rows.append(row);
          }
          section.append(toggle,rows);list.append(section);
        }
        fitChipRows();restoreReadingPosition(before,scrollTop,focused);
        if(animate)transition(before,measure(),exits);
        hasBaseline=ready;
      }
      for(const {pie,row,time} of pies){const age=Math.max(0,at-time);row.style.setProperty('--completion-tint',(14*Math.max(0,1-age/1800)).toFixed(3)+'%');pie.style.setProperty('--elapsed-angle',Math.min(360,age/1800*360)+'deg');pie.title=(stale?'이전 관측값 · ':'')+Math.floor(age/60)+'분 전 완료 · '+new Date(time*1000).toLocaleString('ko-KR');pie.setAttribute('aria-label',pie.title);}
    }
    return {render(state,now,isStale){
      const wasStale=stale;stale=isStale;arrivals.clear();if(stale)cancelMotion();
      if(!stale){
        snapshot=state?.snapshot;at=now;
        const next=new Map((snapshot?.sessions||[]).map(r=>[identity(r),r.status]));
        if(observed&&!wasStale&&!document.hidden)for(const [key,status] of next){
          if(status==='completed'&&observed.has(key)&&observed.get(key)!=='completed')arrivals.add(key);
        }
        observed=next;
      }
      draw(!wasStale);arrivals.clear();
    },select(provider){controls.provider=controls.provider===provider?'all':provider;onSelect(controls.provider);cancelMotion();draw(false);},reset(){cancelMotion();hasBaseline=false;snapshot=null;at=null;signature='';pies=[];observed=null;arrivals.clear();}};
  }
  const api={groups,hierarchy,layout,create,readPreview};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.LocalMonitorFolders=api;
})(typeof window!=='undefined'?window:globalThis);
