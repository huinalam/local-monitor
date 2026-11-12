const {test}=require('node:test');const assert=require('node:assert/strict');
const {classify,parse,skyAt}=require('../local_monitor/web/weather.js');
const now=Date.UTC(2026,9,7,3)/1000;
const raw={timezone:'Asia/Seoul',current:{time:now,temperature_2m:20,weather_code:0,is_day:1},daily:{sunrise:[now-18000],sunset:[now+21600]}};
test('WMO classification and unknown data',()=>{for(const [codes,kind] of [[[0],'clear'],[[1,2],'partly'],[[3],'cloudy'],[[45,48],'fog'],[[51,53,55,56,57,61,63,65,66,67,80,81,82],'rain'],[[71,73,75,77,85,86],'snow'],[[95,96,99],'storm'],[[null,undefined,100,NaN,'0'],'unknown']])for(const c of codes)assert.equal(classify(c),kind);});
test('reject invalid or old data',()=>{for(const current of [null,{...raw.current,temperature_2m:null},{...raw.current,time:now-10000},{...raw.current,is_day:2},{...raw.current,weather_code:'0'}])assert.throws(()=>parse({...raw,current},now));assert.equal(parse(raw,now).temp,20);});
test('sun boundaries and local time fallback',()=>{const p=parse(raw,now);assert.equal(skyAt(p,now).phase,'day');assert.equal(skyAt(p,now+25000).phase,'night');assert.equal(skyAt(p,now-18000).phase,'dawn');assert.equal(skyAt(p,now+21600).phase,'dusk');assert.deepEqual(skyAt(null,now),{phase:'day',estimated:true});assert.equal(skyAt(null,now+43200).phase,'night');});
test('malformed sunrise entries cannot break clock',()=>{const p=parse({...raw,daily:{sunrise:[null],sunset:[5]}},now);assert.deepEqual(p.sun,[]);assert.equal(skyAt(p,now).phase,'day');});
const {orbitAt}=require('../local_monitor/web/weather.js');
test('sun arc uses local sunrise, sunset and clamped twilight endpoints',()=>{
 const rise=Date.UTC(2026,9,28,0)/1000,set=rise+36000,s={zone:'Asia/Seoul',sun:[{rise,set}]};
 assert.equal(orbitAt(s,rise,'dawn').x,8);assert.equal(orbitAt(s,set,'dusk').x,92);
 const noon=orbitAt(s,(rise+set)/2,'day');assert.equal(noon.x,50);assert.equal(noon.y,10);assert.equal(noon.estimated,false);
 assert.equal(orbitAt(s,rise-600,'dawn').progress,0);assert.equal(orbitAt(s,set+600,'dusk').progress,1);
});
test('decorative moon crosses midnight using adjacent sunset and sunrise',()=>{
 const rise=Date.UTC(2026,9,27,21)/1000,set=rise+43200,nextRise=rise+86400;
 const sample={zone:'Asia/Seoul',sun:[{rise,set},{rise:nextRise,set:set+86400}]};
 const moon=orbitAt(sample,(set+nextRise)/2,'night');assert.equal(moon.body,'moon');assert.equal(moon.progress,.5);assert.equal(moon.estimated,false);
 const fallback=orbitAt(null,Date.UTC(2026,9,28,15)/1000,'night');assert.equal(fallback.progress,.5);assert.equal(fallback.estimated,true);
 assert.equal(orbitAt(null,Date.UTC(2026,9,28,3)/1000,'day').x,50);
});
