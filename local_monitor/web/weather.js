'use strict';
(() => {
  const cities={seoul:{name:'서울',lat:37.57,lon:126.98},busan:{name:'부산',lat:35.18,lon:129.08},incheon:{name:'인천',lat:37.46,lon:126.71},daejeon:{name:'대전',lat:36.35,lon:127.38},daegu:{name:'대구',lat:35.87,lon:128.60},gwangju:{name:'광주',lat:35.16,lon:126.85},jeju:{name:'제주',lat:33.50,lon:126.53},gangneung:{name:'강릉',lat:37.75,lon:128.88}};
  const names={clear:'맑음',partly:'구름 조금',cloudy:'흐림',fog:'안개',rain:'비',snow:'눈',storm:'뇌우',unknown:'날씨 확인 불가'};
  const finite=Number.isFinite;
  function classify(code){
    if(code===0)return 'clear';if(code===1||code===2)return 'partly';if(code===3)return 'cloudy';
    if([45,48].includes(code))return 'fog';
    if([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(code))return 'rain';
    if([71,73,75,77,85,86].includes(code))return 'snow';
    if([95,96,99].includes(code))return 'storm';return 'unknown';
  }
  function parse(raw,now=Date.now()/1000){
    const c=raw?.current,d=raw?.daily;
    if(!c||!finite(c.time)||Math.abs(now-c.time)>7200||!finite(c.temperature_2m)||c.temperature_2m < -100||c.temperature_2m>70||!Number.isInteger(c.weather_code)||![0,1].includes(c.is_day))throw Error('weather_invalid');
    let zone=raw.timezone;
    try{new Intl.DateTimeFormat('en',{timeZone:zone}).format();}catch{zone='Asia/Seoul';}
    const sun=Array.isArray(d?.sunrise)?d.sunrise.map((rise,i)=>({rise,set:d.sunset?.[i]})).filter(x=>finite(x.rise)&&finite(x.set)&&x.rise<x.set&&Math.abs(x.rise-now)<604800):[];
    return {at:c.time,received:now,temp:c.temperature_2m,code:c.weather_code,isDay:c.is_day,zone:zone||'Asia/Seoul',sun};
  }
  function skyAt(sample,now=Date.now()/1000,zone='Asia/Seoul'){
    zone=sample?.zone||zone;
    const date=seconds=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(seconds*1000));
    const sun=sample?.sun?.find(s=>date(s.rise)===date(now));
    if(sun){
      if(Math.abs(now-sun.rise)<1800)return {phase:'dawn',estimated:false};
      if(Math.abs(now-sun.set)<1800)return {phase:'dusk',estimated:false};
      return {phase:now>=sun.rise&&now<sun.set?'day':'night',estimated:false};
    }
    if(sample&&now-sample.at<3600)return {phase:sample.isDay?'day':'night',estimated:false};
    const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',hourCycle:'h23'}).format(new Date(now*1000)));
    return {phase:hour>=6&&hour<18?'day':'night',estimated:true};
  }
  function orbitAt(sample,now=Date.now()/1000,phase=skyAt(sample,now).phase){
    const body=phase==='night'?'moon':'sun';
    const zone=sample?.zone||'Asia/Seoul';
    const date=t=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t*1000));
    const sun=(sample?.sun||[]).filter(s=>finite(s.rise)&&finite(s.set)&&s.rise<s.set);
    let start,end;
    if(body==='sun'){
      const day=sun.find(s=>date(s.rise)===date(now));start=day?.rise;end=day?.set;
    }else{
      start=Math.max(...sun.filter(s=>s.set<=now).map(s=>s.set));
      end=Math.min(...sun.filter(s=>s.rise>now).map(s=>s.rise));
    }
    const estimated=!finite(start)||!finite(end)||end<=start;
    let progress;
    if(!estimated)progress=(now-start)/(end-start);
    else{
      const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now*1000));
      const value=type=>Number(parts.find(p=>p.type===type).value);
      const hour=value('hour')+value('minute')/60+value('second')/3600;
      progress=body==='moon'?((hour-18+24)%24)/12:(hour-6)/12;
    }
    progress=Math.max(0,Math.min(1,progress));
    return {body,progress,estimated,x:8+84*progress,y:32-22*Math.sin(Math.PI*progress)};
  }
  if(typeof module!=='undefined'&&module.exports){module.exports={classify,parse,skyAt,orbitAt};return;}
  const $=id=>document.getElementById(id),root=document.documentElement;
  const load=key=>{try{return JSON.parse(localStorage.getItem(key));}catch{return null;}};
  const save=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
  let location={...cities.seoul,id:'default'},sample=null,failed=false,loading=false,notice='',request=null,generation=0,timer=null,attempted=0,locating=false,lastActive=null;
  const stored=load('lm-weather-location');
  if(stored&&Object.hasOwn(cities,stored.id))location={...cities[stored.id],id:stored.id};
  else if(stored?.id==='current'&&finite(stored.lat)&&Math.abs(stored.lat)<=90&&finite(stored.lon)&&Math.abs(stored.lon)<=180)location={id:'current',name:'현재 위치',lat:Math.round(stored.lat*100)/100,lon:Math.round(stored.lon*100)/100};
  const key=()=>location.lat+','+location.lon;
  function readCache(){
    sample=null;attempted=0;failed=false;
    const cached=load('lm-weather-cache');
    if(cached?.key!==key())return;
    const v=cached.sample,now=Date.now()/1000;
    if(!v||!finite(v.at)||!finite(v.received)||v.received>now+60||v.at>now+60||!finite(v.temp)||!Number.isInteger(v.code)||![0,1].includes(v.isDay)||!Array.isArray(v.sun))return;
    try{new Intl.DateTimeFormat('en',{timeZone:v.zone}).format();}catch{return;}
    sample={...v,sun:v.sun.filter(s=>s&&finite(s.rise)&&finite(s.set)&&s.rise<s.set&&Math.abs(s.rise-now)<604800)};
    attempted=v.received*1000;
  }
  const active=()=>root.dataset.theme==='real'||!!$('workshop-grid');
  function paint(){
    $('weather-settings').hidden=!active();$('weather-chip').hidden=!active();
    if(!active())return;
    const now=Date.now()/1000,sky=skyAt(sample,now),usable=sample&&now-sample.at<21600;
    const kind=usable?classify(sample.code):'unknown';
    const journeyKind=usable&&!failed&&now-sample.at<=3600?kind:'unknown';
    const changed=root.dataset.sky!==sky.phase||root.dataset.weather!==kind||root.dataset.journeyWeather!==journeyKind;
    root.dataset.journeyWeather=journeyKind;
    const orbit=orbitAt(sample,now,sky.phase);
    root.dataset.orbitMotion=root.dataset.orbitBody===orbit.body?'steady':'reset';
    root.dataset.orbitBody=orbit.body;
    root.style.setProperty('--journey-orb-x',orbit.x+'%');root.style.setProperty('--journey-orb-y',orbit.y+'px');
    root.dataset.sky=sky.phase;root.dataset.weather=kind;
    if(changed)document.dispatchEvent(new Event('weatherchange'));
    const stale=failed||(sample&&now-sample.at>3600);
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');
    icon.setAttribute('viewBox','0 0 16 16');icon.setAttribute('aria-hidden','true');icon.classList.add('weather-pixel');
    const path=document.createElementNS(icon.namespaceURI,'path');
    const shapes={sun:'M7 0h2v3H7z M7 13h2v3H7z M0 7h3v2H0z M13 7h3v2h-3z M5 4h6v1h1v6h-1v1H5v-1H4V5h1z',moon:'M5 1h5v2H7v2H5v5h2v2h5v-2h2v3h-2v2H5v-2H3v-2H1V5h2V3h2z',cloud:'M5 3h5v2h3v2h2v5H1V7h2V5h2z',rain:'M5 1h5v2h3v2h2v5H1V5h2V3h2z M3 12h2v3H3z M7 11h2v3H7z M11 12h2v3h-2z',snow:'M7 1h2v4h2V3h2v2h-2v2h4v2h-4v2h2v2h-2v-2H9v4H7v-4H5v2H3v-2h2V9H1V7h4V5H3V3h2v2h2z',unknown:'M4 2h8v2h2v4h-2v2H9v2H7V8h3V6h2V4H4v2H2V4h2z M7 14h2v2H7z'};
    const shape=kind==='clear'?(sky.phase==='night'?'moon':'sun'):kind==='snow'?'snow':['rain','storm'].includes(kind)?'rain':kind==='unknown'?'unknown':'cloud';
    icon.dataset.shape=shape;
    path.setAttribute('d',shapes[shape]);path.setAttribute('fill','currentColor');icon.append(path);
    const place=document.createElement('span');place.className='weather-chip-place';place.textContent=location.name.replace(' · 기본 위치','')+' ';
    const condition=document.createElement('span');condition.className='weather-chip-condition';condition.textContent=(kind==='unknown'?(loading?'확인 중':'확인 불가'):names[kind])+' · ';
    $('weather-chip').replaceChildren(icon,place,condition,document.createTextNode((usable?Math.round(sample.temp)+'°':'—')+(stale?' · 이전':'')));
    $('weather-chip').title=location.name+' · '+names[kind];
    $('weather-chip').setAttribute('aria-label',location.name+' '+names[kind]+(usable?' '+Math.round(sample.temp)+'도':''));
    $('weather-place').textContent=location.name+(location.id==='default'?' · 기본 위치':'');
    const observed=sample?new Intl.DateTimeFormat('ko-KR',{timeZone:sample.zone,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(sample.at*1000)):'';
    $('weather-status').textContent=[names[kind],loading?'조회 중':failed?'갱신 실패 · 15분 후 재조회':stale?'갱신 지연':'',observed?'자료 시각 '+observed:'',sky.estimated?'낮밤은 현지 시각 기준 추정':'',notice].filter(Boolean).join(' · ');
    $('weather-city').value=location.id;
  }
  async function fetchWeather(){
    if(!active())return;
    request?.abort();const mine=++generation,controller=new AbortController();request=controller;loading=true;attempted=Date.now();paint();
    const query=new URLSearchParams({latitude:location.lat,longitude:location.lon,current:'temperature_2m,weather_code,is_day,cloud_cover',daily:'sunrise,sunset',timeformat:'unixtime',timezone:'auto',forecast_days:'3'});
    const timeout=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetch('https://api.open-meteo.com/v1/forecast?'+query,{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer'});
      if(!response.ok)throw Error('weather_http');
      const next=parse(await response.json());
      if(mine!==generation||!active())return;
      sample=next;failed=false;save('lm-weather-cache',{key:key(),sample});
    }catch{
      if(mine===generation&&active())failed=true;
    }finally{
      clearTimeout(timeout);
      if(mine===generation){loading=false;request=null;paint();}
    }
  }
  function choose(next){
    request?.abort();generation++;loading=false;location=next;save('lm-weather-location',location);readCache();paint();if(active())fetchWeather();
  }
  function activate(){
    if(lastActive===active()){paint();return;}
    lastActive=active();
    if(!active()){locating=false;$('weather-locate').disabled=false;}
    clearInterval(timer);timer=null;request?.abort();request=null;generation++;loading=false;
    paint();if(!active())return;
    if(!sample||Date.now()-attempted>=900000)fetchWeather();
    timer=setInterval(()=>{paint();if(!loading&&Date.now()-attempted>=900000)fetchWeather();},30000);
  }
  $('weather-city').addEventListener('change',event=>{
    locating=false;$('weather-locate').disabled=false;notice='';
    const id=event.target.value;
    choose(Object.hasOwn(cities,id)?{...cities[id],id}:{...cities.seoul,id:'default'});
  });
  $('weather-locate').addEventListener('click',()=>{
    if(locating)return;locating=true;$('weather-locate').disabled=true;notice='위치를 확인하고 있어요.';paint();
    const finish=next=>{if(!locating)return;locating=false;$('weather-locate').disabled=false;choose(next);};
    const fallback=()=>{if(!locating)return;notice='위치를 얻지 못해 서울 기본값을 사용해요.';finish({...cities.seoul,id:'default'});};
    if(!navigator.geolocation){fallback();return;}
    navigator.geolocation.getCurrentPosition(position=>{
      if(!locating)return;notice='';finish({id:'current',name:'현재 위치',lat:Math.round(position.coords.latitude*100)/100,lon:Math.round(position.coords.longitude*100)/100});
    },fallback,{enableHighAccuracy:false,timeout:10000,maximumAge:3600000});
  });
  $('weather-chip').addEventListener('click',()=>{document.querySelector('.settings').open=true;$('weather-city').focus();});
  document.addEventListener('themechange',activate);
  readCache();activate();
})();
