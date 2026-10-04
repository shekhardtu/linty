import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from './ui.fixture.mjs';
const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const port = process.env.UI_PORT ?? '1466';
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',port,'--strictPort'],{stdio:['ignore','pipe','pipe']});
let browser;
const errors=[];
try {
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Preview startup timed out')),15000);
    server.stdout.on('data',chunk=>{if(String(chunk).includes(port)){clearTimeout(timer);resolve();}});
    server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Preview exited ${code}`));});
  });
  browser=await engine.launch({headless:true});
  const page=await browser.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(fixture,{});
  await page.addInitScript(()=>{
    const original=window.__TAURI_INTERNALS__.invoke;
    window.__QA__.handlers={}; window.__QA__.capsule=[]; window.__QA__.generation=0;
    window.__TAURI_INTERNALS__.invoke=(command,args)=>{
      if(command==='plugin:global-shortcut|register') for(const shortcut of args.shortcuts) window.__QA__.handlers[shortcut]=args.handler.onmessage;
      if(command==='plugin:global-shortcut|unregister') for(const shortcut of args.shortcuts) delete window.__QA__.handlers[shortcut];
      if(command==='emit_capsule_state') window.__QA__.capsule.push(args);
      if(command==='history_save') window.__QA__.savedAudioGeneration=args.recordingGeneration;
      if(command==='start_dictation') {
        window.__QA__.calls.push(command);
        if(window.__QA__.delayStart) return new Promise(resolve=>{window.__QA__.resolveStart=()=>resolve(++window.__QA__.generation);});
        return Promise.resolve(++window.__QA__.generation);
      }
      if(command==='stop_dictation') {
        window.__QA__.calls.push(command);
        window.__QA__.stoppedGenerations??=[];
        window.__QA__.stoppedGenerations.push(args.generation);
        const result={sample_count:window.__QA__.hasAudio?32000:0,duration_secs:window.__QA__.hasAudio?2:0,recording_generation:args.generation};
        if(window.__QA__.delayStop) return new Promise(resolve=>{
          window.__QA__.stops??={};
          window.__QA__.stops[args.generation]=()=>resolve(result);
        });
        return Promise.resolve(result);
      }
      if(command==='dictation_result') {
        window.__QA__.calls.push(command);
        const complete=()=>{
          const failed=window.__QA__.failPaste;
          const deliveryStatus=failed?'failed':window.__QA__.deliveryStatus??'verified';
          const record={transcriptId:'native-'+args.generation,rawText:'Private words stay out of the pill.',finalText:'Private words stay out of the pill.',deliveryStatus,timestamp:Date.now(),durationSeconds:2,processingTimeMs:100,wordCount:8,engine:'local',modelName:'Fixture',corrected:false};
          if(args.generation===window.__QA__.generation) window.__QA__.capsule.push(failed?{state:'error',error:'Paste failed · copy from History'}:{state:deliveryStatus==='verified'?'done':'idle'});
          window.__QA__.savedAudioGeneration=args.generation;
          return original('history_save',{record,recordingGeneration:args.generation}).then(()=>({record,warnings:[],recognized:[],corrected:[]}));
        };
        if(window.__QA__.delayResult) return new Promise(resolve=>{
          window.__QA__.results??={};
          window.__QA__.results[args.generation]=()=>resolve(complete());
        });
        return complete();
      }
      return original(command,args);
    };
    document.hasFocus=()=>false;
  });
  await page.goto(url);
  await page.getByRole('heading',{name:'Your dictation',exact:true}).waitFor();
  const store=await page.evaluateHandle(async()=>(await import('/src/store/app.store.ts')).useAppStore);
  const status=s=>page.waitForFunction(({store,s})=>store.getState().status===s,{store,s});
  const get=()=>store.evaluate(s=>({recording:s.getState().isRecording,handsFree:s.getState().handsFree,quiet:s.getState().quietSeconds,generation:s.getState().recordingGeneration}));
  const count=command=>page.evaluate(command=>window.__QA__.calls.filter(c=>c===command).length,command);
  const single=source=>page.evaluate(source=>{
    const fire=state=>source==='modifier'?window.__QA__.emit(state==='Pressed'?'fnkey-pressed':'fnkey-released'):window.__QA__.handlers[source]({state,shortcut:source});
    fire('Pressed');fire('Released');
  },source);
  const double=source=>page.evaluate(source=>{
    const fire=state=>source==='modifier'?window.__QA__.emit(state==='Pressed'?'fnkey-pressed':'fnkey-released'):window.__QA__.handlers[source]({state,shortcut:source});
    fire('Pressed');fire('Released');fire('Pressed');fire('Released');
  },source);
  await page.clock.install();
  for(const trigger of ['fn','modifier:right-command','Control+Option+Space']) {
    await store.evaluate((s,trigger)=>s.getState().setTriggerKey(trigger),trigger);
    const source=trigger==='Control+Option+Space'?trigger:'modifier';
    if(source!=='modifier') await page.waitForFunction(source=>!!window.__QA__.handlers[source],source);
    else await page.clock.runFor(10);
    const starts=await count('start_dictation'), stops=await count('stop_dictation');
    await double(source); await status('recording'); await page.clock.runFor(500);
    assert.equal((await get()).handsFree,true,`${trigger} latches`);
    assert.equal(await count('start_dictation'),starts+1);
    assert.equal(await count('stop_dictation'),stops);
    await single(source); await status('idle');
    assert.equal(await count('stop_dictation'),stops+1);
    await double(source); await status('recording');
    assert.equal(await count('start_dictation'),starts+2,`${trigger}: a fresh press immediately opens the next recording`);
    await single(source); await status('idle');
    assert.equal(await count('stop_dictation'),stops+2);
  }
  // Alternate shortcut has the same gestures, and latching survives slow startup.
  await store.evaluate(s=>s.getState().setTriggerKey('fn')); await page.clock.runFor(10);
  const alternate='CommandOrControl+Shift+Space';
  await page.waitForFunction(key=>!!window.__QA__.handlers[key],alternate);
  // Single-press finishing also works while the microphone is still opening.
  let starts=await count('start_dictation'), stops=await count('stop_dictation');
  await page.evaluate(()=>{window.__QA__.delayStart=true;});
  await double('modifier');
  await page.waitForFunction(()=>!!window.__QA__.resolveStart);
  await single(alternate);
  await page.evaluate(()=>{window.__QA__.resolveStart();window.__QA__.delayStart=false;delete window.__QA__.resolveStart;});
  await status('idle');
  assert.equal(await count('stop_dictation'),stops+1,'The pending microphone closes once it opens');
  await double('modifier'); await status('recording');
  assert.equal(await count('start_dictation'),starts+2,'The next trigger starts without a stop guard');
  await single('modifier'); await status('idle');
  await page.evaluate(()=>{window.__QA__.delayStart=true;});
  await double(alternate);
  await page.waitForFunction(()=>!!window.__QA__.resolveStart);
  await page.clock.runFor(600);
  await page.evaluate(()=>{window.__QA__.resolveStart();window.__QA__.delayStart=false;});
  await status('recording'); assert.equal((await get()).handsFree,true);
  let generation=(await get()).generation;
  await page.evaluate(generation=>window.__QA__.emit('recording-quiet',{generation,quiet_seconds:20}),generation);
  assert.equal((await get()).quiet,20);
  await page.evaluate(generation=>window.__QA__.emit('recording-quiet',{generation,quiet_seconds:0}),generation);
  assert.equal((await get()).quiet,0,'Input clears the warning');
  let inferences=await count('dictation_result');
  const recoveries=await count('recover_recording');
  await page.evaluate(()=>{window.__QA__.capsule=[];});
  await page.evaluate(generation=>window.__QA__.emit('recording-auto-stopped',{generation,quiet_seconds:30,heard_input:false}),generation);
  await status('idle');
  await page.waitForFunction(()=>window.__QA__.capsule.at(-1)?.state==='quiet-stop');
  assert.equal(await page.evaluate(()=>window.__QA__.capsule.some(s=>s.state==='idle')),false,'Empty auto-stop never hides the pill between listening and its notice');
  assert.equal(await count('dictation_result'),inferences,'An empty auto-stop does not run inference');
  assert.equal(await count('recover_recording'),recoveries,'Discarding empty audio does not cancel unrelated background delivery');
  await page.evaluate(()=>{window.__QA__.hasAudio=true;});
  await double('modifier'); await status('recording');
  const newer=(await get()).generation;
  await page.evaluate(generation=>window.__QA__.emit('recording-auto-stopped',{generation,quiet_seconds:30,heard_input:true}),generation);
  assert.equal((await get()).recording,true,'A stale timeout cannot stop the new session');
  await page.evaluate(generation=>{
    window.__QA__.emit('recording-auto-stopped',{generation,quiet_seconds:30,heard_input:true});
    window.__QA__.emit('fnkey-released');
  },newer);
  await status('done');
  assert.equal(await count('dictation_result'),inferences+1,'Input is transcribed once on auto-stop');
  assert.equal(await count('dictation_result'),1);
  assert.equal(await page.evaluate(()=>window.__QA__.savedAudioGeneration),newer,'History receives the exact native recording generation');
  const done=await page.evaluate(()=>window.__QA__.capsule.findLast(s=>s.state==='done'));
  assert.deepEqual(done,{state:'done'},'The success payload never contains transcript text');
  await page.evaluate(()=>{window.__QA__.hasAudio=false;});
  await double('modifier'); await status('recording');
  await store.evaluate(s=>s.getState().setTriggerKey('Control+Option+Space'));
  await status('idle');
  assert.equal((await get()).handsFree,false,'Changing the configured trigger finishes the old capture');
  await page.evaluate(()=>{window.__QA__.hasAudio=true;});
  starts=await count('start_dictation');
  const pastes=await count('dictation_result');
  await double('Control+Option+Space'); await status('recording');
  await single('Control+Option+Space'); await status('done');
  assert.equal(await count('dictation_result'),pastes+1,'One press wraps up and delivers the recording');
  await double('Control+Option+Space'); await status('recording');
  assert.equal(await count('start_dictation'),starts+2,'Another trigger immediately starts the next take after delivery');
  await single('Control+Option+Space'); await status('done');
  assert.equal(await count('dictation_result'),pastes+2);
  await store.evaluate(s=>s.getState().toasts.forEach(toast=>s.getState().removeToast(toast.toastId)));
  await page.evaluate(()=>{window.__QA__.deliveryStatus='unverified';});
  await double('Control+Option+Space'); await status('recording');
  const sounds=await count('play_capsule_sound');
  const deliveries=await count('dictation_result');
  await single('Control+Option+Space'); await status('done');
  await page.clock.runFor(501);
  assert.deepEqual(await store.evaluate(s=>s.getState().toasts),[],'An unreadable destination does not produce a warning');
  assert.equal(await count('play_capsule_sound'),sounds,'Unverified insertion does not play a success sound');
  assert.equal(await count('dictation_result'),deliveries+1,'Unverified delivery is not retried');
  assert.equal(await store.evaluate(s=>s.getState().finalText),'Private words stay out of the pill.','Text remains available after quiet completion');
  await page.evaluate(()=>{window.__QA__.hasAudio=true;window.__QA__.failPaste=true;window.__QA__.capsule=[];});
  await double('Control+Option+Space'); await status('recording');
  await single('Control+Option+Space'); await status('done');
  await page.waitForFunction(()=>window.__QA__.capsule.at(-1)?.state==='error');
  assert.equal(await page.evaluate(()=>window.__QA__.capsule.some(s=>s.state==='done')),false,'A failed paste must never show a success checkmark');
  assert.equal(await page.evaluate(()=>window.__QA__.capsule.at(-1).error),'Paste failed · copy from History');
  assert.ok(await store.evaluate(s=>s.getState().toasts.some(toast=>toast.type==='error' && toast.action?.label==='Copy text')),'A failed paste keeps its copy recovery action');

  // A blocked background delivery never blocks or resets the next capture.
  await page.clock.runFor(501);
  await page.evaluate(()=>{window.__QA__.failPaste=false;window.__QA__.delayResult=true;});
  await double('Control+Option+Space'); await status('recording');
  const background=(await get()).generation;
  await single('Control+Option+Space');
  await page.waitForFunction(g=>!!window.__QA__.results?.[g],background);
  await page.evaluate(g=>window.__QA__.emit('dictation-stage',{generation:g,stage:'pasting'}),background);
  await status('pasting');
  assert.equal(await store.evaluate(s=>s.getState().pendingDictations),1);
  starts=await count('start_dictation');
  await double('Control+Option+Space'); await status('recording');
  const concurrent=(await get()).generation;
  assert.equal(await count('start_dictation'),starts+1,'A trigger starts capture while the previous paste is pending');
  await page.waitForFunction(()=>window.__QA__.capsule.at(-1)?.state==='recording');
  await page.evaluate(g=>window.__QA__.emit('dictation-stage',{generation:g,stage:'correcting'}),background);
  assert.equal(await store.evaluate(s=>s.getState().status),'recording','Older stages cannot overwrite the newer capture');
  const beforeHides=await count('hide_capsule');
  await page.evaluate(g=>window.__QA__.results[g](),background);
  await page.waitForFunction(store=>store.getState().pendingDictations===0,store);
  assert.equal((await get()).recording,true,'Background completion leaves the new microphone running');
  assert.equal((await get()).generation,concurrent);
  await page.clock.runFor(10000);
  assert.equal(await count('hide_capsule'),beforeHides,'Background completion cannot schedule a hide for the current pill');
  assert.equal(await store.evaluate(s=>s.getState().status),'recording');
  await single('Control+Option+Space');
  await page.waitForFunction(g=>!!window.__QA__.results?.[g],concurrent);
  await page.evaluate(()=>{window.__QA__.hasAudio=false;window.__QA__.delayResult=false;});
  await double('Control+Option+Space'); await status('recording');
  await single('Control+Option+Space'); await status('idle');
  assert.equal(await store.evaluate(s=>s.getState().pendingDictations),1,'An empty newer capture does not mark background delivery as idle for updates');
  await page.evaluate(g=>window.__QA__.results[g](),concurrent);
  await page.waitForFunction(store=>store.getState().pendingDictations===0,store);
  assert.equal(await store.evaluate(s=>s.getState().status),'idle','A late delivery cannot reopen the newest empty capture');
  assert.equal(await page.evaluate(()=>window.__QA__.savedAudioGeneration),concurrent,'Each background result retains its audio generation');

  // A press during shutdown is accepted, including release before it opens.
  await page.evaluate(()=>{window.__QA__.hasAudio=true;window.__QA__.delayStop=true;window.__QA__.delayResult=true;});
  await double('Control+Option+Space'); await status('recording');
  const closing=(await get()).generation;
  await single('Control+Option+Space');
  await page.waitForFunction(g=>!!window.__QA__.stops?.[g],closing);
  starts=await count('start_dictation'); stops=await count('stop_dictation');
  await double('Control+Option+Space');
  assert.equal(await store.evaluate(s=>s.getState().status),'preparing','The new trigger is acknowledged during microphone shutdown');
  assert.equal(await count('start_dictation'),starts,'The new stream waits only for the old stream to close');
  await single('Control+Option+Space');
  await page.evaluate(g=>{window.__QA__.delayStop=false;window.__QA__.stops[g]();},closing);
  await page.waitForFunction(starts=>window.__QA__.calls.filter(c=>c==='start_dictation').length===starts+1,starts);
  await page.waitForFunction(stops=>window.__QA__.calls.filter(c=>c==='stop_dictation').length===stops+1,stops);
  const queued=await page.evaluate(()=>window.__QA__.generation);
  assert.deepEqual(await page.evaluate(()=>window.__QA__.stoppedGenerations.slice(-2)),[closing,queued],'Both captures close exactly once with their own generation');
  await page.waitForFunction(g=>!!window.__QA__.results?.[g],queued);
  assert.equal((await get()).recording,false,'A queued take released during shutdown cannot leave the microphone open');
  await page.evaluate(g=>window.__QA__.results[g](),closing);
  await page.evaluate(g=>window.__QA__.results[g](),queued);
  await status('done');
  await page.waitForFunction(store=>store.getState().pendingDictations===0,store);
  await page.evaluate(()=>{window.__QA__.delayResult=false;});

  await mkdir('artifacts/dictation-pill',{recursive:true});
  // WebKit document focus can remain true while the native window is inactive.
  await page.evaluate(()=>{
    window.__QA__.hasAudio=false; window.__QA__.failPaste=false;
    window.__QA__.windowFocused=false; document.hasFocus=()=>true;
  });
  await page.clock.runFor(501);
  starts=await count('start_dictation');
  await double('Control+Option+Space'); await status('recording');
  await page.waitForFunction(()=>window.__QA__.capsule.at(-1)?.state==='recording');
  assert.equal(await page.getByRole('dialog',{name:'Focused dictation',exact:true}).count(),0,'Stale document focus cannot suppress the background pill');
  let hides=await count('hide_capsule');
  await page.evaluate(()=>{window.__QA__.windowFocused=true;window.__QA__.emit('tauri://focus',true);});
  await page.getByRole('dialog',{name:'Focused dictation',exact:true}).waitFor();
  await page.waitForFunction(hides=>window.__QA__.calls.filter(c=>c==='hide_capsule').length>hides,hides);
  let shows=await count('show_capsule');
  await page.evaluate(()=>{window.__QA__.windowFocused=false;window.__QA__.emit('tauri://blur',false);});
  await page.waitForFunction(shows=>window.__QA__.calls.filter(c=>c==='show_capsule').length>shows,shows);
  assert.equal(await count('start_dictation'),starts+1,'Switching apps moves feedback without restarting the microphone');
  await store.evaluate(s=>s.getState().setStatus('transcribing'));
  await page.evaluate(()=>{window.__QA__.windowFocused=true;window.__QA__.emit('tauri://focus',true);});
  await page.clock.runFor(10);
  await page.evaluate(()=>{window.__QA__.windowFocused=false;window.__QA__.emit('tauri://blur',false);});
  await page.waitForFunction(()=>window.__QA__.capsule.at(-1)?.state==='transcribing');
  await store.evaluate(s=>s.getState().setStatus('recording'));
  await single('Control+Option+Space'); await status('idle');
  await page.getByRole('button',{name:'Back now',exact:true}).click();
  for(const nativeState of [{windowFocused:true,windowVisible:false},{windowFocused:true,windowMinimized:true}]) {
    await page.clock.runFor(501);
    await page.evaluate(nativeState=>{Object.assign(window.__QA__,{windowVisible:true,windowMinimized:false},nativeState);},nativeState);
    await double('Control+Option+Space'); await status('recording');
    await page.waitForFunction(()=>window.__QA__.capsule.at(-1)?.state==='recording');
    assert.equal(await page.getByRole('dialog',{name:'Focused dictation',exact:true}).count(),0,'A hidden or minimized Linty window uses the pill');
    await single('Control+Option+Space'); await status('idle');
  }
  await page.evaluate(()=>{delete window.__QA__.windowFocused;delete window.__QA__.windowVisible;delete window.__QA__.windowMinimized;});
  // Focused dictation uses native input history, just like the pill.
  await page.evaluate(()=>{window.__QA__.hasAudio=false;window.__QA__.failPaste=false;delete window.__QA__.deliveryStatus;document.hasFocus=()=>true;});
  await page.getByRole('button',{name:'System Check',exact:true}).click();
  assert.equal(await page.locator('.microphone-test').count(),0,'System Check has no embedded recorder');
  await page.clock.runFor(501);
  await double('Control+Option+Space'); await status('recording');
  const focus=page.getByRole('dialog',{name:'Focused dictation',exact:true});
  const microphoneTest=focus.locator('.microphone-test');
  const startTest=focus.getByRole('button',{name:'Try again',exact:true});
  const stopTest=focus.getByRole('button',{name:'Stop & transcribe',exact:true});
  await page.waitForFunction(()=>document.querySelectorAll('.microphone-test .waveform-bar').length===80);
  await page.clock.runFor(100);
  const liveControl=await stopTest.boundingBox();
  assert.ok(liveControl.width >= 154,'The microphone control has a readable action label');
  const testLevels=()=>microphoneTest.locator('.waveform-bar').evaluateAll(bars=>bars.map(bar=>new DOMMatrix(bar.style.transform).d));
  const feedTest=async levels=>{
    await page.evaluate(levels=>{for(const rms of levels) window.__QA__.emit('audio-amplitude',rms);},levels);
    await page.clock.runFor(70);
  };
  await feedTest(Array(100).fill(.003));
  assert.ok((await testLevels()).every(height=>height<.2),'The app test keeps background noise close to the baseline');
  await feedTest(Array(100).fill(.05));
  assert.ok((await testLevels()).every(height=>height>.35 && height<.6),'Normal input leaves room for emphasis in the app test');
  await feedTest(Array(120).fill(0));
  assert.ok((await testLevels()).every(height=>Math.abs(height-.1)<.000001),'Repeated zero frames clear the complete history');
  const phrase=[0,.001,.003,.008,.018,.06,.04,.009,.002,0,.001,.005,.025,.09,.04,.018,.004,.001,.0004];
  await feedTest(phrase);
  assert.ok(new Set(await testLevels()).size>10,'The app waveform displays the actual variation in input');
  for(const theme of ['dark','light']) {
    await store.evaluate((s,theme)=>s.getState().setTheme(theme),theme);
    await microphoneTest.screenshot({path:`artifacts/dictation-pill/microphone-test-${engine.name()}-${theme}.png`});
  }
  const releases=await count('plugin:event|unlisten');
  await stopTest.click(); await status('idle');
  await startTest.waitFor();
  assert.equal(await microphoneTest.locator('.waveform-bar').count(),0);
  assert.ok(await count('plugin:event|unlisten')>releases,'Stopping removes the amplitude listener');
  for(const theme of ['dark','light']) {
    await store.evaluate((s,theme)=>s.getState().setTheme(theme),theme);
    await microphoneTest.screenshot({path:`artifacts/dictation-pill/microphone-idle-${engine.name()}-${theme}.png`});
  }
  await startTest.click(); await status('recording');
  await page.clock.runFor(100);
  assert.ok((await testLevels()).every(height=>Math.abs(height-.1)<.000001),'A new test starts with an empty waveform');
  assert.equal(await focus.getByRole('button',{name:'Back to System Check',exact:true}).isDisabled(),true,'Finish recording before closing the dialog');
  await stopTest.click(); await status('idle');
  await focus.getByRole('button',{name:'Back now',exact:true}).click();
  assert.equal(await microphoneTest.count(),0,'Closing the dialog removes the recorder');
  await page.evaluate(()=>{document.hasFocus=()=>false;});
  await page.getByRole('button',{name:'Shortcuts',exact:true}).click();
  await store.evaluate(s=>s.getState().toasts.forEach(toast=>s.getState().removeToast(toast.toastId)));
  await page.clock.runFor(500);
  await page.setViewportSize({width:1080,height:1280});
  for(const theme of ['dark','light']) {
    await store.evaluate((s,theme)=>s.getState().setTheme(theme),theme);
    await page.screenshot({path:`artifacts/dictation-pill/shortcuts-single-finish-${engine.name()}-${theme}.png`,animations:'disabled'});
  }

  // A reload or late listener must recover current state, without replaying a
  // delayed snapshot over a more recent event.
  const recoveryPill=await browser.newPage({viewport:{width:380,height:52},reducedMotion:'reduce'});
  recoveryPill.on('pageerror',e=>errors.push(e.message));
  await recoveryPill.addInitScript(fixture,{});
  await recoveryPill.addInitScript(()=>{
    const original=window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke=(command,args)=>{
      if(command==='get_capsule_state') {
        window.__QA__.calls.push(command);
        if(window.__QA__.deferSnapshot) return new Promise(resolve=>{window.__QA__.resolveSnapshot=resolve;});
        return Promise.resolve({revision:4,state:'recording',generation:12,hands_free:true});
      }
      return original(command,args);
    };
  });
  await recoveryPill.goto(`${url}/capsule.html`);
  await recoveryPill.locator('.capsule-recording').waitFor();
  assert.equal(await recoveryPill.locator('.capsule-time').innerText(),'0:00','The current recording renders even when its initial event was missed');
  await recoveryPill.reload();
  await recoveryPill.locator('.capsule-recording').waitFor();
  await recoveryPill.evaluate(()=>window.__QA__.emit('capsule-state',{revision:3,state:'idle'}));
  assert.equal(await recoveryPill.locator('.capsule-recording').count(),1,'An older queued idle event cannot hide the restored recording');
  await recoveryPill.addInitScript(()=>{window.__QA__.deferSnapshot=true;});
  await recoveryPill.reload();
  await recoveryPill.waitForFunction(()=>!!window.__QA__.resolveSnapshot);
  await recoveryPill.evaluate(()=>{
    window.__QA__.emit('capsule-state',{revision:5,state:'transcribing',generation:12});
    window.__QA__.resolveSnapshot({revision:4,state:'recording',generation:12});
  });
  await recoveryPill.locator('.capsule-transcribing').waitFor();
  assert.equal(await recoveryPill.locator('.capsule-recording').count(),0,'A delayed snapshot cannot overwrite a newer processing event');
  await recoveryPill.evaluate(()=>{
    window.dispatchEvent(new CustomEvent('capsule-state-replay',{detail:{revision:6,state:'pasting',generation:12}}));
    window.__QA__.emit('capsule-state',{revision:5,state:'transcribing',generation:12});
  });
  await recoveryPill.locator('.capsule-pasting').waitFor();
  assert.equal(await recoveryPill.locator('.capsule-transcribing').count(),0,'Resuming the webview carries current state even if the ordinary event was lost');
  await recoveryPill.close();

  for(const theme of ['dark','light']) for(const reducedMotion of ['no-preference','reduce']) {
    const context=await browser.newContext({viewport:{width:380,height:52},reducedMotion});
    const pill=await context.newPage(); pill.on('pageerror',e=>errors.push(e.message));
    await pill.addInitScript(fixture,{theme}); await pill.goto(`${url}/capsule.html`);
    await pill.waitForFunction(()=>window.__QA__?.calls.includes('plugin:event|listen'));
    await pill.clock.install();
    const send=payload=>pill.evaluate(payload=>window.__QA__.emit('capsule-state',payload),payload);
    await send({state:'recording',generation:12,hands_free:true});
    await pill.locator('.capsule-recording').waitFor();
    const brand=pill.getByRole('img',{name:'Linty',exact:true});
    assert.equal(await brand.locator('rect').count(),3,'The existing favicon has three independently animated strokes');
    assert.equal(await brand.locator('rect').first().evaluate(el=>getComputedStyle(el).animationName),'none','The mark has no synthetic looping animation');
    await pill.clock.runFor(200);
    await pill.locator('.capsule-pill').evaluate(el=>Promise.allSettled(el.getAnimations().map(a=>a.finished)));
    const geometry=await pill.locator('.capsule-pill').boundingBox();
    const dragCount=()=>pill.evaluate(()=>window.__QA__.calls.filter(c=>c==='plugin:window|start_dragging').length);
    await brand.click();
    assert.equal(await dragCount(),1,'The locked listening pill invokes native dragging');
    await send({state:'recording',generation:12,hands_free:false});
    await pill.waitForFunction(()=>!document.querySelector('.capsule-pill')?.classList.contains('is-draggable'));
    await brand.click();
    assert.equal(await dragCount(),1,'Hold-to-talk cannot reposition the pill');
    await send({state:'recording',generation:12,hands_free:true});
    await pill.locator('.is-draggable').waitFor();
    await brand.click({button:'right'});
    await pill.getByRole('button',{name:'Finish dictation'}).dispatchEvent('pointerdown',{button:0,isPrimary:true});
    assert.equal(await dragCount(),1,'Right-click and the stop button never start a drag');
    await pill.clock.runFor(1100);
    await send({state:'recording',generation:12,hands_free:true});
    assert.equal(await pill.locator('.capsule-time').innerText(),'0:01','Latching does not restart the duration');
    const feed=async levels=>{
      await pill.evaluate(levels=>{for(const rms of levels) window.__QA__.emit('capsule-amplitude',rms);},levels);
      await pill.clock.runFor(70);
    };
    const waveLevels=()=>pill.locator('.capsule-wave span').evaluateAll(bars=>bars.map(bar=>new DOMMatrix(bar.style.transform).d));
    await feed(Array(24).fill(.001));
    const quietVoice=(await waveLevels()).at(-1);
    assert.ok(quietVoice*20<3,'Low room noise stays under 3 px in the 20 px display');
    await feed(Array(24).fill(.003));
    assert.ok((await waveLevels()).at(-1)*20<4,'Background noise leaves most vertical travel available for speech');
    await feed(Array(24).fill(.05));
    const ordinaryVoice=(await waveLevels()).at(-1);
    await feed(Array(24).fill(.2));
    const loudVoice=(await waveLevels()).at(-1);
    assert.ok(quietVoice>0.1 && ordinaryVoice>quietVoice && loudVoice>ordinaryVoice && loudVoice<1,'Quiet, ordinary and loud input have distinct heights without early saturation');
    assert.ok(ordinaryVoice*20>7 && ordinaryVoice*20<12,'Ordinary input sits in the middle of the available height');
    await feed(Array(24).fill(1));
    assert.ok((await waveLevels()).at(-1)*20<=18.21,'Even full-scale input leaves space above and below the bars');
    await feed(Array(45).fill(0));
    await feed([.2]);
    const attack=(await waveLevels()).at(-1);
    assert.ok(attack>quietVoice && attack<loudVoice,'One loud transient is softened without suppressing its response');
    await feed([0]);
    assert.ok((await waveLevels()).at(-1)<attack && (await waveLevels()).at(-1)>0.1,'The release eases back instead of snapping to silence');
    await feed(Array(45).fill(0));
    assert.ok((await waveLevels()).every(height=>Math.abs(height-0.1)<0.000001),'Silence settles to the baseline without decorative motion');
    assert.equal(await pill.locator('.capsule-favicon.is-speaking').count(),0);
    await pill.evaluate(()=>{
      for(const rms of [0,.001,.003,.008,.018,.06,.04,.009,.002,0,.001,.005,.025,.09,.04,.018,.004,.001,.0004]) window.__QA__.emit('capsule-amplitude',rms);
      window.__QA__.emit('recording-quiet',{generation:11,quiet_seconds:25});
    });
    await pill.locator('.capsule-favicon.is-speaking').waitFor();
    assert.ok(new Set(await waveLevels()).size>10,'The waveform retains modulation in actual input history');
    await brand.evaluate(el=>Promise.allSettled(el.getAnimations({subtree:true}).map(a=>a.finished)));
    if(reducedMotion==='no-preference') {
      const heights=await brand.locator('rect').evaluateAll(bars=>bars.map(el=>new DOMMatrix(getComputedStyle(el).transform).d));
      assert.equal(new Set(heights).size,3,'Each favicon stroke follows a staggered input sample');
    } else {
      assert.ok((await brand.locator('rect').evaluateAll(bars=>bars.map(el=>getComputedStyle(el).transform))).every(transform=>transform==='none'),'Reduced motion keeps the favicon still');
    }
    await pill.locator('.capsule-wave').evaluate(el=>Promise.allSettled(el.getAnimations({subtree:true}).map(a=>a.finished)));
    await pill.screenshot({path:`artifacts/dictation-pill/listening-${theme}-${reducedMotion}.png`});
    assert.equal(await pill.locator('.capsule-quiet').count(),0);
    await pill.evaluate(()=>window.__QA__.emit('recording-quiet',{generation:12,quiet_seconds:24}));
    await pill.getByText('Stopping…',{exact:true}).waitFor();
    const stopButton=pill.getByRole('button',{name:'Finish dictation'});
    assert.equal(await stopButton.innerText(),'6s','Remaining seconds sit inside the stop button');
    assert.equal(await pill.locator('.capsule-quiet-message').innerText(),'Stopping…','The single-line warning explicitly explains the countdown');
    assert.equal(await pill.locator('.capsule-favicon.is-speaking').count(),0,'The quiet warning never looks like active talking');
    assert.equal(await pill.locator('.capsule-pill').evaluate(el=>el.offsetHeight),geometry.height,'The warning does not grow the pill');
    await pill.clock.runFor(200);
    await pill.locator('.capsule-content').evaluate(el=>Promise.allSettled(el.getAnimations().map(a=>a.finished)));
    await pill.screenshot({path:`artifacts/dictation-pill/quiet-${theme}-${reducedMotion}.png`});
    const assertCircle=async()=>{
      const button=await stopButton.boundingBox();
      const number=await pill.locator('.capsule-countdown-label').boundingBox();
      const svg=await pill.locator('.capsule-stop-countdown svg').boundingBox();
      assert.equal(button.width,24); assert.equal(button.height,24,'The stop control is a full circle, never an oval');
      assert.deepEqual(svg,button,'The circular track shares the button bounds');
      assert.ok(Math.abs(number.x+number.width/2-button.x-button.width/2)<.05,`Countdown is horizontally centered: ${JSON.stringify({button,number})}`);
      assert.ok(Math.abs(number.y+number.height/2-button.y-button.height/2)<.05,'Countdown is vertically centered');
      assert.equal(await pill.locator('.capsule-countdown-track').evaluate(el=>getComputedStyle(el).strokeDasharray),'none','A complete track remains behind the retreating arc');
    };
    await assertCircle();
    const ring=pill.locator('.capsule-countdown-ring');
    const sweep=await ring.evaluateHandle(el=>el.getAnimations()[0]);
    await pill.evaluate(()=>window.__QA__.emit('recording-quiet',{generation:12,quiet_seconds:25}));
    await pill.waitForFunction(()=>document.querySelector('.capsule-countdown-label')?.textContent==='5s');
    assert.equal(await stopButton.innerText(),'5s');
    if(reducedMotion==='no-preference') {
      assert.equal(await ring.evaluate((el,sweep)=>el.getAnimations()[0]===sweep,sweep),true,'Updating the numeral must not restart the sweep');
      assert.equal(await ring.evaluate(el=>el.getAnimations()[0].effect.getTiming().duration),6000);
    } else {
      assert.equal(await ring.evaluate(el=>el.getAnimations().length),0,'Reduced motion uses a static arc');
      assert.equal(await ring.getAttribute('stroke-dashoffset'),'50');
    }
    await pill.evaluate(()=>window.__QA__.emit('recording-quiet',{generation:12,quiet_seconds:0}));
    await pill.locator('.capsule-stop-countdown').waitFor({state:'detached'});
    assert.equal(await pill.locator('.capsule-stop-countdown').count(),0,'Input clears the countdown');
    await pill.evaluate(()=>window.__QA__.emit('recording-quiet',{generation:12,quiet_seconds:20}));
    await pill.waitForFunction(()=>document.querySelector('.capsule-countdown-label')?.textContent==='10s');
    assert.equal(await stopButton.innerText(),'10s','A fresh warning starts a fresh countdown');
    await assertCircle();
    if(reducedMotion==='no-preference') assert.equal(await ring.evaluate(el=>el.getAnimations()[0].effect.getTiming().duration),10000);
    await stopButton.click();
    assert.equal(await pill.evaluate(()=>window.__QA__.emittedEvents.filter(e=>e.event==='capsule-stop').length),1);
    const shell=await pill.locator('.capsule-pill').elementHandle();
    const orbit=await pill.locator('.capsule-orbit').evaluateHandle(el=>el.getAnimations()[0]);
    const settle=()=>pill.locator('.capsule-pill').evaluate(el=>Promise.allSettled(el.getAnimations({subtree:true})
      .filter(a=>a.playState!=='paused' && a.effect.getTiming().iterations!==Infinity).map(a=>a.finished)));
    for(const state of ['transcribing','correcting','pasting','done']) {
      await send({state,text:'Private transcript must not render.'});
      await pill.locator(`.capsule-${state}`).waitFor();
      await pill.evaluate(()=>window.__QA__.emit('capsule-partial-text','Private partial text must not render.'));
      assert.equal(await pill.locator('.capsule-pill').evaluate((el,shell)=>el===shell,shell),true,'States share one shell instead of remounting and flickering');
      if(state==='transcribing' && reducedMotion==='no-preference') {
        const midway=await pill.locator('.capsule-pill').evaluate(el=>{
          const transition=el.getAnimations().find(a=>a.transitionProperty==='width');
          if(!transition) return null;
          transition.pause(); transition.currentTime=180;
          const bounds=el.getBoundingClientRect();
          return {width:bounds.width,center:bounds.x+bounds.width/2};
        });
        assert.ok(midway && midway.width>40 && midway.width<geometry.width,'The shell contracts through intermediate widths');
        assert.equal(midway.center,geometry.x+geometry.width/2,'Contraction stays anchored to the same center');
        await pill.screenshot({path:`artifacts/dictation-pill/contracting-${theme}-${reducedMotion}.png`});
        await pill.locator('.capsule-pill').evaluate(el=>el.getAnimations().find(a=>a.transitionProperty==='width')?.finish());
      }
      await pill.clock.runFor(200);
      await settle();
      await pill.locator('.capsule-pill').click();
      assert.equal(await dragCount(),1,'Processing and completion stay fixed even after hands-free listening');
      assert.equal(await pill.getByText(/Private/).count(),0);
      const bounds=await pill.locator('.capsule-pill').boundingBox();
      assert.equal(bounds.width,40,'Processing and success contract to a circle');
      assert.equal(bounds.height,40,'The circular shell retains the listening height');
      const emblem=await pill.locator('.capsule-emblem').boundingBox();
      assert.equal(emblem.x+emblem.width/2,bounds.x+bounds.width/2,'The state icon is horizontally centered');
      assert.equal(emblem.y+emblem.height/2,bounds.y+bounds.height/2,'The state icon is vertically centered');
      assert.equal(await pill.getByRole('button',{name:'Finish dictation'}).count(),0,'Fading recording controls leave the accessibility tree immediately');
      assert.ok(bounds.y>=0 && bounds.y+bounds.height<=52,'Pill fits the native panel');
      if(state!=='done' && reducedMotion==='no-preference') {
        assert.equal(await pill.locator('.capsule-orbit').evaluate((el,orbit)=>el.getAnimations()[0]===orbit,orbit),true,'Processing substates never restart the orbit');
      }
      if(state==='done') {
        assert.equal(await pill.locator('.capsule-success').evaluate(el=>getComputedStyle(el).opacity),'1');
        assert.equal(await pill.locator('.capsule-success path').evaluate(el=>getComputedStyle(el).strokeDashoffset),'0px','The checkmark finishes drawing');
        const orbitState=await pill.locator('.capsule-orbit').evaluate(el=>({classes:el.closest('.capsule-pill').className,css:getComputedStyle(el).animationPlayState,animations:el.getAnimations().map(a=>({name:a.animationName,state:a.playState,iterations:a.effect.getTiming().iterations}))}));
        assert.equal(orbitState.animations.some(a=>a.state==='running'),false,`Success stops continuous animation work (${theme}, ${reducedMotion}): ${JSON.stringify(orbitState)}`);
      }
      if(reducedMotion==='reduce') assert.equal(await pill.locator('.capsule-pill').evaluate(el=>el.getAnimations({subtree:true}).length),0,'Reduced motion has no active morph or spin');
      await pill.screenshot({path:`artifacts/dictation-pill/${state}-${theme}-${reducedMotion}.png`});
    }
    await pill.clock.runFor(1200);
    assert.equal(await pill.locator('.capsule-pill').count(),0,'Success fades away');
    await send({state:'pasting'}); await pill.locator('.capsule-pasting').waitFor();
    await send({state:'idle'}); await pill.clock.runFor(200);
    assert.equal(await pill.locator('.capsule-pill').count(),0,'Unverified delivery dismisses without an error or success checkmark');
    assert.equal(await pill.getByRole('status').innerText(),'','Quiet completion leaves no warning announcement');
    await send({state:'recording',generation:13}); await pill.clock.runFor(200);
    await send({state:'idle'}); await pill.clock.runFor(80);
    await send({state:'recording',generation:14}); await pill.clock.runFor(300);
    assert.equal(await pill.locator('.capsule-recording').count(),1,'An old fade cannot hide a new recording');
    await settle();
    await send({state:'transcribing'}); await pill.locator('.capsule-transcribing').waitFor();
    await pill.clock.runFor(30);
    await send({state:'done'}); await pill.locator('.capsule-done').waitFor();
    await settle();
    assert.equal((await pill.locator('.capsule-pill').boundingBox()).width,40,'A fast result completes the same contraction');
    await send({state:'recording',generation:15}); await pill.locator('.capsule-recording').waitFor();
    await pill.clock.runFor(1200); await settle();
    assert.equal((await pill.locator('.capsule-pill').boundingBox()).width,geometry.width,'A new recording expands and survives the old success deadline');
    await send({state:'preparing'}); await pill.locator('.capsule-preparing').waitFor(); await settle();
    assert.equal((await pill.locator('.capsule-pill').boundingBox()).width,geometry.width,'Preparation leaves room for a visible explanation');
    assert.equal(await pill.locator('.capsule-message').innerText(),'Getting ready…');
    assert.equal(await pill.getByRole('button',{name:'Finish dictation'}).count(),0,'Preparation has no recording controls');
    assert.equal(await pill.locator('.capsule-spinner').evaluate(el=>getComputedStyle(el).opacity),'1');
    await pill.screenshot({path:`artifacts/dictation-pill/preparing-${theme}-${reducedMotion}.png`});
    await send({state:'error',error:'Microphone disconnected. Choose another input.'});
    await pill.locator('.capsule-error').waitFor(); await settle();
    assert.equal((await pill.locator('.capsule-pill').boundingBox()).width,352,'A processing error expands to a readable single line');
    assert.deepEqual((await new AxeBuilder({page:pill}).withTags(['wcag2a','wcag2aa']).analyze()).violations,[]);
    await send({state:'preparing'}); await pill.locator('.capsule-preparing').waitFor();
    assert.equal(await pill.locator('.capsule-message').innerText(),'Getting ready…','Retry replaces the error with preparation feedback');
    await context.close();
  }
  assert.deepEqual(errors,[]);
  console.log(`Dictation checks passed in ${engine.name()}: native focus, app switching, capsule reload/resume, configured triggers, overlapping capture and ordered background results, silence recovery, stale events, paste outcomes, microphone waveform and cleanup, locked-only dragging, favicon, no transcript, centered morph, continuous processing, fast completion, interruption, reduced motion and accessibility.`);
} finally { await browser?.close(); server.kill(); }
