import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DictationTrigger } from '../src/lib/dictation-trigger.ts';

function setup(t) {
  t.mock.timers.enable({apis:['setTimeout']});
  const calls = [];
  const trigger = new DictationTrigger({start:()=>calls.push('start'),stop:()=>calls.push('stop'),latch:()=>calls.push('latch')});
  return {calls,trigger};
}
for (const source of ['modifier','accelerator']) {
  test(`${source}: hold to talk stops on release, repeat is ignored`, t => {
    const {calls,trigger} = setup(t);
    trigger.press(source,0); trigger.press(source,100); trigger.release(source,900);
    assert.deepEqual(calls,['start','stop']);
    t.mock.timers.tick(1000);
    assert.deepEqual(calls,['start','stop']);
  });
  test(`${source}: double-press locks, then one press finishes immediately`, t => {
    const {calls,trigger} = setup(t);
    trigger.press(source,0); trigger.release(source,50);
    t.mock.timers.tick(80);
    trigger.press(source,130); trigger.release(source,180);
    t.mock.timers.tick(1000);
    assert.deepEqual(calls,['start','latch']);
    trigger.press(source,1500);
    assert.deepEqual(calls,['start','latch','stop'],'Finishes on key down without another tap or release');
    trigger.release(source,1550);
    trigger.press(source,1650); trigger.press(source,1680);
    assert.deepEqual(calls,['start','latch','stop'],'An old double-press habit never restarts the microphone');
    trigger.release(source,1700);
    trigger.press(source,1900); trigger.release(source,1900);
    assert.deepEqual(calls,['start','latch','stop'],'The full double-press window belongs to finishing');
    trigger.press(source,1901); trigger.release(source,2300);
    assert.deepEqual(calls,['start','latch','stop','start','stop'],'A fresh gesture works after the short guard');
  });
}
test('a single quick tap ends after its double-press window',t=>{
  const {calls,trigger}=setup(t);
  trigger.press('modifier',0); trigger.release('modifier',80);
  t.mock.timers.tick(319); assert.deepEqual(calls,['start']);
  t.mock.timers.tick(1); assert.deepEqual(calls,['start','stop']);
});
test('mixing shortcuts does not accidentally latch and recovery clears a pending release',t=>{
  const {calls,trigger}=setup(t);
  trigger.press('modifier',0); trigger.release('modifier',50);
  trigger.press('accelerator',100); trigger.release('accelerator',150);
  assert.deepEqual(calls,['start']);
  trigger.reset(); t.mock.timers.tick(1000);
  assert.deepEqual(calls,['start']);
  trigger.press('accelerator',2000); trigger.release('accelerator',2500);
  assert.deepEqual(calls,['start','start','stop']);
});
test('either shortcut can switch off a latched session',t=>{
  const {calls,trigger}=setup(t);
  trigger.press('modifier',0); trigger.release('modifier',50);
  trigger.press('modifier',150); trigger.release('modifier',200);
  trigger.press('accelerator',1000);
  assert.deepEqual(calls,['start','latch','stop'],'The alternate shortcut finishes on its first press');
  trigger.release('accelerator',1050);
  trigger.press('modifier',1200); trigger.release('modifier',1250);
  assert.deepEqual(calls,['start','latch','stop'],'A trailing tap on either shortcut is consumed');
});
test('stop suppression survives completion and recovery resets',t=>{
  const {calls,trigger}=setup(t);
  trigger.press('modifier',0); trigger.release('modifier',50);
  trigger.press('modifier',150); trigger.release('modifier',200);
  trigger.press('modifier',1000); trigger.release('modifier',1050);
  trigger.reset(true);
  trigger.press('modifier',1100); trigger.release('modifier',1150);
  trigger.reset();
  trigger.press('accelerator',1200); trigger.release('accelerator',1250);
  assert.deepEqual(calls,['start','latch','stop']);
  trigger.press('accelerator',1401); trigger.release('accelerator',1700);
  assert.deepEqual(calls,['start','latch','stop','start','stop']);
});
test('a suppressed extra press cannot turn into a hold when the guard expires',t=>{
  const {calls,trigger}=setup(t);
  trigger.press('modifier',0); trigger.release('modifier',50);
  trigger.press('modifier',150); trigger.release('modifier',200);
  trigger.press('modifier',1000); trigger.release('modifier',1050);
  trigger.press('modifier',1100);
  trigger.press('modifier',1600); trigger.release('modifier',1700);
  t.mock.timers.tick(2000);
  assert.deepEqual(calls,['start','latch','stop']);
  trigger.press('modifier',1800); trigger.release('modifier',2200);
  assert.deepEqual(calls,['start','latch','stop','start','stop']);
});
