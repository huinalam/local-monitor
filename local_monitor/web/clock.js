'use strict';
(() => {
  window.LocalMonitorClock={create(){
    let anchor=null,received=0,mode='unknown';
    const valid=t=>Number.isFinite(t)&&t>0;
    const now=()=>anchor===null?null:anchor+Math.max(0,performance.now()-received)/1000;
    function sync(serverTime,rtt=0,source='server'){
      if(!valid(serverTime))return;
      anchor=serverTime+(Number.isFinite(rtt)?Math.max(0,Math.min(5000,rtt))/2000:0);received=performance.now();mode=source;
    }
    return {now,sync,observe(serverTime){
      if(valid(serverTime)&&(now()===null||serverTime>now()))sync(serverTime);
    },age(at){const current=now();return valid(at)&&current!==null?Math.max(0,current-at):null;},get mode(){return mode;}};
  }};
})();
