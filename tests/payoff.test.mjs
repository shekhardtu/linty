import test from 'node:test';
import assert from 'node:assert/strict';
import {estimatePayoff,typingSpeed,validTypingSpeed,formatEstimatedTime,previousUsageWindow,canCompareHistory,paceChange} from '../src/lib/payoff.util.ts';
const timing={words:6240,seconds:2880,processingSeconds:180,sessions:150,missingSessions:0};
test('estimated time rounds partial minutes up while preserving zero and whole minutes',()=>{
 for(const [seconds,expected] of [[0,'0m'],[0.1,'1m'],[29,'1m'],[60,'1m'],[60.1,'2m'],[3599,'1h'],[3600,'1h'],[3601,'1h 1m'],[-0.1,'1m'],[-60.1,'2m']])assert.equal(formatEstimatedTime(seconds),expected);
 const short=estimatePayoff({words:33,seconds:33/121*60,processingSeconds:5,sessions:1,missingSessions:0},40);
 assert.ok(short.savedSeconds>0 && short.savedSeconds<30);
 assert.equal(formatEstimatedTime(short.savedSeconds),'1m');
});
test('savings include processing and respond to a personal baseline without clamping losses',()=>{
 const estimate=estimatePayoff(timing,40);assert.equal(estimate.typingSeconds,9360);assert.equal(estimate.savedSeconds,6300);assert.equal(estimate.wordsPerMinute,130);assert.equal(formatEstimatedTime(estimate.savedSeconds),'1h 45m');
 assert.equal(estimatePayoff(timing,60).savedSeconds,3180);
 assert.ok(estimatePayoff(timing,180).savedSeconds<0);
 assert.equal(typingSpeed(NaN),40);assert.equal(typingSpeed(0),40);assert.equal(validTypingSpeed(201),false);assert.equal(validTypingSpeed(40.5),false);
});
test('missing/empty timing does not manufacture a speed or savings estimate',()=>{
 for(const incomplete of [{sessions:0},{words:0},{seconds:0},{processingSeconds:0}])assert.equal(estimatePayoff({...timing,...incomplete},40),null);
 assert.equal(paceChange(timing,{...timing,sessions:1}),null);
 assert.equal(paceChange(timing,{...timing,words:5664}),10);
 assert.equal(paceChange(timing,null),null);
});
test('comparison windows preserve local calendar time across daylight saving',()=>{
 const tz=process.env.TZ;process.env.TZ='America/New_York';
 try{
  const now=new Date(2026,2,10,14,30).getTime();const prior=previousUsageWindow('7d',now);
  assert.equal(new Date(prior.start).getDate(),25);assert.equal(new Date(prior.start).getMonth(),1);
  assert.equal(new Date(prior.end).getDate(),3);assert.equal(new Date(prior.end).getHours(),14);assert.equal(new Date(prior.end).getMinutes(),30);
  assert.equal(now-prior.end,7*86400000-3600000);assert.equal(previousUsageWindow('all',now),null);
 }finally{if(tz===undefined)delete process.env.TZ;else process.env.TZ=tz;}
});
test('new and expired history cannot supply a misleading personal comparison',()=>{
 const now=200*86400000,start=140*86400000;
 assert.equal(canCompareHistory(100*86400000,0,start,now),true);
 assert.equal(canCompareHistory(150*86400000,0,start,now),false);
 assert.equal(canCompareHistory(100*86400000,30,start,now),false);
 assert.equal(canCompareHistory(null,0,start,now),false);
});
