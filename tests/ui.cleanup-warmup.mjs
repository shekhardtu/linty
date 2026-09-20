import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright';
const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
import { fixture } from './ui.fixture.mjs';
const port=process.env.UI_PORT??'1459';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',port,'--strictPort'],{stdio:['ignore','pipe','pipe']});
let browser;const errors=[];
try {
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Preview timeout')),15000);server.stdout.on('data',c=>{if(String(c).includes(port)){clearTimeout(timer);resolve();}});server.once('exit',reject);});
  browser=await engine.launch({headless:true});const page=await browser.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(fixture,{empty:true});
  await page.addInitScript(()=>{
    const qa=window.__QA__;const original=window.__TAURI_INTERNALS__.invoke;
    qa.stores[1].transcriptionLanguage='en';qa.generation=0;qa.warm=false;qa.preparations=[];qa.warmups=[];qa.sampleCount=16000;
    qa.nextOutcome={record:null,warnings:[],recognized:[],corrected:[]};
    let preparation;
    const prepare=()=>qa.warm?Promise.resolve():preparation??=(new Promise((resolve,reject)=>qa.warmups.push({resolve:()=>{qa.warm=true;resolve();},reject})).finally(()=>{preparation=null;}));
    void original('download_s1_model');
    window.__TAURI_INTERNALS__.invoke=(command,args)=>{
      if(command==='prepare_dictation'){qa.calls.push(command);qa.preparations.push(args);return prepare();}
      if(command==='prepare_s1_model'){qa.calls.push(command);return prepare();}
      if(command==='start_dictation'){qa.calls.push(command);qa.options=structuredClone(args.options);return Promise.resolve(++qa.generation);}
      if(command==='stop_dictation'){qa.calls.push(command);return Promise.resolve({sample_count:qa.sampleCount,duration_secs:1,recording_generation:qa.generation});}
      if(command==='dictation_result'){
        qa.calls.push(command);
        return new Promise(resolve=>{qa.finishNative=()=>{
          if(qa.nextOutcome.record)qa.stores[2].transcripts.unshift(qa.nextOutcome.record);
          qa.emit('dictation-history-changed');resolve(structuredClone(qa.nextOutcome));
        };});
      }
      return original(command,args);
    };
    document.hasFocus=()=>false;
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole('heading',{name:'Your dictation',exact:true}).waitFor();
  const store=await page.evaluateHandle(async()=>(await import('/src/store/app.store.ts')).useAppStore);
  const status=value=>page.waitForFunction(({store,value})=>store.getState().status===value,{store,value});
  const press=()=>page.evaluate(()=>window.__QA__.emit('fnkey-pressed'));
  const release=()=>page.evaluate(()=>window.__QA__.emit('fnkey-released'));
  await page.waitForFunction(()=>window.__QA__.warmups.length===1);
  await page.getByRole('button',{name:'On-device: Preparing. Configure speech engine'}).waitFor();
  await press();await status('recording');
  const captured=await page.evaluate(()=>window.__QA__.options);
  await store.evaluate(s=>s.getState().setLoadedModelFilename('parakeet-tdt-0.6b-v3'));
  assert.deepEqual(await page.evaluate(()=>window.__QA__.options),captured,'Recording settings are sent once, before subsequent UI edits');
  await release();await status('preparing');
  await page.waitForFunction(()=>!!window.__QA__.finishNative);
  assert.equal(await store.evaluate(s=>s.getState().isRecording),false,'Waiting for native work never keeps the microphone UI active');
  await page.evaluate(()=>window.__QA__.emit('dictation-stage',{generation:window.__QA__.generation-1,stage:'pasting'}));
  await status('preparing');
  await page.evaluate(()=>window.__QA__.emit('dictation-stage',{generation:window.__QA__.generation,stage:'correcting'}));
  await status('correcting');
  await page.evaluate(()=>{window.__QA__.warmups[0].resolve();window.__QA__.finishNative();delete window.__QA__.finishNative;});
  await status('idle');
  for(const command of ['transcribe_buffer','reformat_transcript','snapshot_clipboard','paste_text','history_save']) {
    assert.equal(await page.evaluate(c=>window.__QA__.calls.includes(c),command),false,`UI must not orchestrate ${command}`);
  }
  // A no-op (filler-only) native result is quiet; the next meaningful result is shown.
  assert.equal(await store.evaluate(s=>s.getState().toasts.length),0);
  await page.evaluate(()=>{
    window.__QA__.nextOutcome={record:{transcriptId:'short',rawText:'no',finalText:'No.',deliveryStatus:'verified',timestamp:Date.now(),wordCount:1,durationSeconds:1,processingTimeMs:120,engine:'local',modelName:'Fixture',corrected:true},warnings:[],recognized:[],corrected:[]};
  });
  await press();await status('recording');await release();await page.waitForFunction(()=>!!window.__QA__.finishNative);
  await page.evaluate(()=>{window.__QA__.finishNative();delete window.__QA__.finishNative;});await status('done');
  assert.equal(await store.evaluate(s=>s.getState().finalText),'No.');
  // Native preservation fallback remains visible and does not trigger a UI rewrite.
  await page.evaluate(()=>{
    const raw='the budget is one lakh fifty thousand rupees';
    window.__QA__.nextOutcome={record:{transcriptId:'protected',rawText:raw,finalText:raw,deliveryStatus:'unverified',textValidation:{status:'fallback',reasons:['units_changed']},timestamp:Date.now(),wordCount:9,durationSeconds:2,processingTimeMs:200,engine:'local',modelName:'Fixture',corrected:false},warnings:['Cleanup changed protected details. Your original transcript was kept.'],recognized:[],corrected:[]};
  });
  await press();await status('recording');await release();await page.waitForFunction(()=>!!window.__QA__.finishNative);
  await page.evaluate(()=>{window.__QA__.finishNative();delete window.__QA__.finishNative;});await status('done');
  assert.equal(await store.evaluate(s=>s.getState().finalText),'the budget is one lakh fifty thousand rupees');
  assert.ok(await store.evaluate(s=>s.getState().toasts.some(t=>t.message.includes('original transcript was kept'))));
  await page.getByRole('button',{name:'Copy text',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__QA__.clipboard),'the budget is one lakh fifty thousand rupees');
  // Cleanup opt-in waits for preparation, rolls back failure, and can be retried.
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Settings',exact:true}).click();
  await page.evaluate(()=>{window.__QA__.warm=false;});
  const choose=async label=>{await page.getByRole('combobox',{name:'Text cleanup',exact:true}).click();await page.getByRole('option',{name:label,exact:true}).click();};
  await choose('Clean up on this Mac');
  await page.waitForFunction(()=>window.__QA__.warmups.length===2);
  assert.equal(await store.evaluate(s=>s.getState().reformatEnabled),false);
  await page.evaluate(()=>window.__QA__.warmups[1].reject(new Error('Synthetic warm-up failure')));
  await page.getByRole('alert').filter({hasText:'Synthetic warm-up failure'}).waitFor();
  assert.equal(await store.evaluate(s=>s.getState().reformatEnabled),false);
  await page.getByRole('button',{name:'Use on-device cleanup',exact:true}).click();
  await page.waitForFunction(()=>window.__QA__.warmups.length===3);
  await page.evaluate(()=>window.__QA__.warmups[2].resolve());
  await page.waitForFunction(()=>window.__QA__.stores[1].reformatEnabled===true);
  await choose('Keep as spoken');await page.waitForFunction(()=>window.__QA__.stores[1].reformatEnabled===false);
  assert.equal(await page.evaluate(()=>window.__QA__.calls.includes('unload_s1_model')),false);
  assert.deepEqual(errors,[]);
  console.log('Native dictation UI contract passed: immutable settings, generation-filtered progress, no frontend processing side effects, filler result, preservation fallback, copy action and cleanup preparation rollback.');
} finally {await browser?.close();server.kill('SIGTERM');}
