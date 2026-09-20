import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from './ui.fixture.mjs';

const engine = process.env.UI_BROWSER === 'webkit' ? webkit : chromium;
const port = process.env.UI_PORT ?? '1451';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
const errors = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview did not start')), 15000);
    server.stdout.on('data', chunk => { if (String(chunk).includes(port)) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited: ${code}`)); });
  });
  browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fixture, {});
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole('heading', {name:'Your dictation',exact:true}).waitFor();
  await page.evaluate(() => {
    // Exercise the out-of-app hotkey path used by the native capsule.
    document.hasFocus = () => false;
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__QA__.capsule = [];
    window.__QA__.deferred = {};
    window.__QA__.answers = {};
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === 'emit_capsule_state') window.__QA__.capsule.push(args);
      if (command in window.__QA__.deferred) return new Promise((resolve, reject) => { window.__QA__.deferred[command] = {resolve,reject}; });
      if (command in window.__QA__.answers) { window.__QA__.calls.push(command); return Promise.resolve(window.__QA__.answers[command]); }
      return original(command, args);
    };
  });
  const state = () => page.evaluate(async () => {
    const s = (await import('/src/store/app.store.ts')).useAppStore.getState();
    return {status:s.status,isRecording:s.isRecording,error:s.error,finalText:s.finalText};
  });
  const store = await page.evaluateHandle(async () => (await import('/src/store/app.store.ts')).useAppStore);
  const waitStatus = status => page.waitForFunction(({store,status}) => store.getState().status === status, {store,status});
  const press = () => page.evaluate(() => window.__QA__.emit('fnkey-pressed'));
  const release = () => page.evaluate(() => window.__QA__.emit('fnkey-released'));
  const recovering = await page.evaluateHandle(async () => (await import('/src/services/dictation-recovery.service.ts')).isRecoveringDictation);
  const waitRecovery = () => page.waitForFunction(recovering => !recovering(), recovering);
  const lastCapsule = () => page.evaluate(() => window.__QA__.capsule.at(-1));
  const clearCalls = () => page.evaluate(() => { window.__QA__.calls = []; window.__QA__.capsule = []; });

  // A failed startup explains the failure in the capsule; an empty recording
  // on the very next attempt ends idle, without an orphan transcribing event.
  await page.evaluate(() => { window.__QA__.failures.start_dictation = 'Microphone unavailable'; });
  await press(); await waitStatus('error'); await waitRecovery();
  assert.equal((await lastCapsule()).error, 'Microphone unavailable');
  await page.evaluate(() => { delete window.__QA__.failures.start_dictation; });
  await clearCalls(); await press(); await waitStatus('recording'); await release(); await waitStatus('idle');
  assert.equal((await lastCapsule()).state, 'idle');
  assert.equal(await page.evaluate(() => window.__QA__.capsule.some(s => s.state === 'transcribing')), false);

  // Quick release waits for startup and does not flash listening afterwards.
  await page.evaluate(() => { window.__QA__.deferred.start_dictation = null; });
  await press(); await page.waitForFunction(() => window.__QA__.deferred.start_dictation?.resolve);
  await clearCalls(); await release();
  assert.equal(await page.evaluate(() => window.__QA__.calls.includes('stop_dictation')), false);
  await page.evaluate(() => { window.__QA__.deferred.start_dictation.resolve(); delete window.__QA__.deferred.start_dictation; });
  await waitStatus('idle');
  assert.equal((await lastCapsule()).state, 'idle');

  // Waking an idle app is silent; waking during capture cancels that session.
  await clearCalls();
  await page.evaluate(() => window.__QA__.emit('system-wake'));
  assert.equal(await page.evaluate(() => window.__QA__.calls.includes('recover_recording')), false);
  await press(); await waitStatus('recording');
  await page.evaluate(() => window.__QA__.emit('system-wake'));
  await waitStatus('error'); await waitRecovery();
  assert.match((await lastCapsule()).error, /interrupted by sleep/);

  // A stream disconnect stops recording and frees the same hotkey for reuse.
  await press(); await waitStatus('recording');
  await page.evaluate(() => window.__QA__.emit('audio-stream-error','Microphone disconnected. Choose another input.'));
  await waitStatus('error'); await waitRecovery();
  assert.equal((await state()).isRecording, false);
  assert.match((await lastCapsule()).error, /Microphone disconnected/);
  await press(); await waitStatus('recording'); await release(); await waitStatus('idle');

  // Dead IPC and inference have deadlines. A late native completion must not
  // resurrect recording, paste old text, or alter a newer successful dictation.
  await page.clock.install();
  await page.evaluate(() => { window.__QA__.deferred.start_dictation = null; });
  await press(); await page.waitForFunction(() => window.__QA__.deferred.start_dictation?.resolve);
  await page.clock.runFor(10001); await waitStatus('error'); await waitRecovery();
  assert.match((await lastCapsule()).error, /Microphone did not start/);
  await page.evaluate(() => { window.__QA__.deferred.start_dictation.resolve(); delete window.__QA__.deferred.start_dictation; });
  assert.equal((await state()).isRecording, false);

  await press(); await waitStatus('recording');
  await page.evaluate(() => { window.__QA__.deferred.stop_dictation = null; });
  await release(); await page.waitForFunction(() => window.__QA__.deferred.stop_dictation?.resolve);
  await page.clock.runFor(5001); await waitStatus('error'); await waitRecovery();
  assert.match((await lastCapsule()).error, /Microphone did not stop/);
  await page.evaluate(() => { window.__QA__.deferred.stop_dictation.resolve({sample_count:32000,duration_secs:2,recording_generation:1}); delete window.__QA__.deferred.stop_dictation; });
  assert.equal((await state()).status,'error');

  await page.evaluate(() => {
    window.__QA__.answers.stop_dictation = {sample_count:32000,duration_secs:2,recording_generation:1};
    window.__QA__.failures.dictation_result = 'Local transcription is unavailable in this build.';
  });
  await press(); await waitStatus('recording'); await release(); await waitStatus('error'); await waitRecovery();
  assert.match((await lastCapsule()).error,/Local transcription is unavailable/);
  await page.evaluate(() => { delete window.__QA__.failures.dictation_result; });

  await page.evaluate(() => {
    window.__QA__.answers.stop_dictation = {sample_count:32000,duration_secs:2,recording_generation:1};
    window.__QA__.deferred.dictation_result = null;
  });
  await press(); await waitStatus('recording'); await release();
  await page.waitForFunction(() => window.__QA__.deferred.dictation_result?.resolve);
  await page.clock.runFor(510001); await waitStatus('error'); await waitRecovery();
  assert.match((await lastCapsule()).error, /Dictation did not finish/);
  await page.evaluate(() => {
    window.__QA__.lateResult = window.__QA__.deferred.dictation_result.resolve;
    delete window.__QA__.deferred.dictation_result;
    window.__QA__.answers.dictation_result = {record:{transcriptId:'recovered',rawText:'Recovered dictation.',finalText:'Recovered dictation.',deliveryStatus:'verified'},warnings:[],recognized:[],corrected:[]};
  });
  await clearCalls(); await press(); await waitStatus('recording'); await release(); await waitStatus('done');
  assert.equal((await state()).finalText, 'Recovered dictation.');
  const pasteCount = await page.evaluate(() => window.__QA__.calls.filter(c => c === 'dictation_result').length);
  await page.evaluate(() => window.__QA__.lateResult({record:{rawText:'Stale result',finalText:'Stale result'},warnings:[],recognized:[],corrected:[]}));
  assert.equal((await state()).finalText, 'Recovered dictation.');
  assert.equal(await page.evaluate(() => window.__QA__.calls.filter(c => c === 'dictation_result').length), pasteCount);
  assert.equal(pasteCount,1);
  assert.equal(await page.evaluate(() => window.__QA__.calls.includes('paste_text')),false,'UI never posts paste commands');

  // Actual capsule renders the explanation, then clears itself.
  const capsule = await browser.newPage({viewport:{width:380,height:52},reducedMotion:'reduce'});
  await capsule.addInitScript(fixture,{});
  await capsule.goto(`http://127.0.0.1:${port}/capsule.html`);
  await capsule.waitForFunction(() => window.__QA__.calls.includes('plugin:event|listen'));
  await capsule.clock.install();
  await capsule.evaluate(() => window.__QA__.emit('capsule-state', { state: 'preparing' }));
  await capsule.getByRole('status').getByText('Getting ready', { exact: true }).waitFor();
  await capsule.locator('.capsule-message').getByText('Getting ready…', { exact: true }).waitFor();
  assert.equal(await capsule.locator('.capsule-recording').count(), 0, 'Preparation must not look like active microphone capture');
  await capsule.screenshot({ path: '/tmp/linty-preparing-capsule.png', animations: 'disabled' });
  await capsule.evaluate(() => window.__QA__.emit('capsule-state',{state:'error',error:'Choose your dictation language in Settings → Language.'}));
  await capsule.locator('.capsule-error').waitFor();
  assert.equal(await capsule.locator('.capsule-error').innerText(), 'Choose your dictation language in Settings → Language.');
  await capsule.clock.runFor(300);
  await capsule.screenshot({path:'/tmp/linty-recovery-capsule.png',animations:'disabled'});
  await capsule.clock.runFor(6500);
  assert.equal(await capsule.locator('.capsule-pill').count(),0);
  assert.deepEqual(errors,[]);
  console.log('Recovery checks passed: capsule errors, empty audio, quick release, microphone loss, startup timeout, inference timeout, retry, and stale-result suppression.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
